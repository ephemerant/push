const vscode = require('vscode');

const ServiceBase = require('../services/ServiceBase');
const ServiceSFTP = require('../services/SFTP');
const ServiceFile = require('../services/File');
const PushBase = require('./PushBase');
const Paths = require('./Paths');
const config = require('./config');
const channel = require('./channel');
const constants = require('./constants');
const i18n = require('../lang/i18n');

class Service extends PushBase {
	constructor(options) {
		super();

		this.setOptions(options);

		this.getStateProgress = this.getStateProgress.bind(this);

		this.services = {
			SFTP: ServiceSFTP,
			File: ServiceFile
		};

		this.activeService = null;
		this.paths = new Paths();
	}

	/**
	 * Edits (or creates) a server configuration file
	 * @param {Uri} uri - Uri to start looking for a configuration file
	 */
	editServiceConfig(uri) {
		let rootPaths, dirName, settingsFile,
			settingsFilename = this.config.settingsFilename;

		uri = this.paths.getFileSrc(uri);
		dirName = this.paths.getDirName(uri, true);

		// Find the nearest settings file
		settingsFile = this.paths.findFileInAncestors(
			settingsFilename,
			dirName
		);

		if (dirName !== ".") {
			// If a directory is defined, use it as the root path
			rootPaths = [{
				uri: vscode.Uri.file(dirName)
			}]
		} else {
			rootPaths = this.paths.getWorkspaceRootPaths();
		}

		if (settingsFile) {
			// Edit the settings file found
			this.openDoc(settingsFile);
		} else {
			// Produce a prompt to create a new settings file
			this.getFileNamePrompt(settingsFilename, rootPaths)
				.then((file) => {
					if (file.exists) {
						this.openDoc(file.fileName);
					} else {
						this.writeAndOpen(
							(file.serviceType.label !== 'Empty' ?
								file.serviceType.settingsPayload :
								constants.DEFAULT_SERVICE_CONFIG
							),
							file.fileName
						);
					}
				});
		}
	}

	/**
	 * Imports a configuration file.
	 * @param {Uri} uri - Uri to start looking for a configuration file
	 * @param {string} type - Type of config to import. Currently only 'SSFTP'
	 * is supported.
	 */
	importConfig(uri) {
		let className, pathName, basename, instance, settings,
			settingsFilename = this.config.settingsFilename;

		pathName = this.paths.getNormalPath(this.paths.getFileSrc(uri));

		if (!(basename = this.paths.getBaseName(pathName))) {
			channel.appendLocalisedError('no_import_file');
		}

		// Figure out which config type this is and import
		for (className in constants.CONFIG_FORMATS) {
			if (constants.CONFIG_FORMATS[className].test(basename)) {
				className = require(`./importers/${className}`);
				instance = new className();

				return instance.import(pathName)
					.then((result) => {
						settings = result;

						return this.getFileNamePrompt(
							settingsFilename,
							this.paths.getDirName(pathName),
							true,
							false
						);
					})
					.then((result) => {
						if (result.exists) {
							// Settings file already exists at this location!
							return vscode.window.showInformationMessage(
								i18n.t('settings_file_exists'),
								{
									title: i18n.t('overwrite')
								}, {
									isCloseAffordance: true,
									title: i18n.t('cancel')
								}
							).then((collisionAnswer) => {
								return ({
									fileName: result.fileName,
									write: (collisionAnswer.title === i18n.t('overwrite'))
								});
							});
						} else {
							// Just create and open
							return ({ fileName: result.fileName, write: true });
						}
					})
					.then((result) => {
						if (result.write) {
							// Write the file
							this.writeAndOpen(
								'\/\/ ' + i18n.t('comm_settings_imported', pathName) +
								JSON.stringify(settings, null, '\t'),
								result.fileName
							);
						}
					})
					.catch((error) => {
						channel.appendError(error);
					});
			}
		}

		channel.appendLocalisedError('import_file_not_supported');
	}

	/**
	 * Produce a settings filename prompt.
	 * @param {string} exampleFileName - Filename example to start with.
	 * @param {vscode.WorkspaceFolder[]} rootPaths - A list of root paths to choose from.
	 * @param {boolean} forceDialog - Force a name prompt if the file exists already.
	 * If `false`, will not display a dialog even if the file exists.
	 * @param {boolean} fromTemplate - Produce a list of service templates with which
	 * to fill the file.
	 */
	getFileNamePrompt(exampleFileName, rootPaths, forceDialog = false, fromTemplate = true) {
		return new Promise((resolve, reject) => {
			// Produce a filename prompt
			this.getRootPathPrompt(rootPaths)
				.then((rootPath) => {
					let fileName = rootPath + Paths.sep + exampleFileName;

					if (!rootPath) {
						return reject();
					}

					// File exists but forceDialog is false - just keep going
					if (this.paths.fileExists(fileName) && !forceDialog) {
						return resolve({ fileName, exists: true });
					}

					// Produce a file prompt
					vscode.window.showInputBox({
						prompt: i18n.t('enter_service_settings_filename'),
						value: fileName
					}).then((fileName) => {
						// Show a service type picker (unless fromTemplate is false)
						if (!fromTemplate) {
							return { fileName };
						}

						if (!fileName) {
							return reject();
						}

						return vscode.window.showQuickPick(
							[{
								'label': i18n.t('empty'),
								'description': i18n.t('empty_template')
							}].concat(this.getList()),
							{
								placeHolder: i18n.t('select_service_type_template')
							}
						).then((serviceType) => {
							return { fileName, serviceType };
						});
					}).then(({ fileName, serviceType }) => {
						resolve({
							fileName,
							exists: this.paths.fileExists(fileName),
							serviceType
						});
					});
				});
		});
	}

	/**
	 * Set class-specific options (Which have nothing to do with the config).
	 * @param {object} options
	 */
	setOptions(options) {
		this.options = Object.assign({}, {
			onDisconnect: null
		}, options);
	}

	/**
	 * Produce a list of the services available.
	 * @return {array} List of the services.
	 */
	getList() {
		let options = [], service;

		for (service in this.services) {
			options.push({
				label: service,
				description: this.services[service].description,
				detail: this.services[service].detail,
				settingsPayload: {
					service,
					'SFTP': this.getServiceDefaults(service)
				}
			});
		}

		return options;
	}

	/**
	 * @description
	 * Similar to base setConfig but allows a mutated config including ad-hoc
	 * service settings. Used primarily with Service#exec to invoke service
	 * specific methods with a service augmented config.
	 *
	 * If the serviceName setting changes, this function will also trigger a
	 * restart of the service instance.
	 * @param {object} [configObject] - optional config set to apply.
	 */
	setConfig(configObject) {
		let restart = (
			typeof configObject !== 'undefined' &&
			configObject.serviceName !== this.config.serviceName
		);

		this.config = Object.assign({}, config.get(), configObject);

		if (restart) {
			// Service name is different or set - instantiate.
			this.restartServiceInstance();
		}
	}

	getStateProgress() {
		return (this.activeService && this.activeService.progress) || null;
	}

	/**
	 * Invokes a method within the active transfer service.
	 * @param {string} method - Method name to invoke.
	 * @param {object} config - Current configuration state.
	 * @param {array} args - Arguments to send to the method, as an array.
	 * @return {mixed} Return result from the service method.
	 */
	exec(method, config, args = []) {
		// Set the current service configuration
		this.setConfig(config);

		if (this.activeService) {
			// Set the active service's config
			this.activeService.setConfig(this.config);

			// Run the service method with supplied arguments
			return this.activeService[method].apply(
				this.activeService,
				args
			);
		}
	}

	stop() {
		if (this.activeService) {
			return new Promise((resolve, reject) => {
				this.activeService.stop()
					.then(() => {
						resolve(this.activeService.type);
					})
					.catch(reject);
			});
		} else {
			return Promise.reject();
		}
	}

	/**
	 * Restarts the currently active service instance
	 */
	restartServiceInstance() {
		if (this.config.serviceName && this.config.service) {
			if (this.activeService) {
				// Run service destructor
				this.activeService.destructor();
			}

			this.activeService = null;
			this.startServiceInstance();
		}
	}

	startServiceInstance() {
		if (this.config.serviceName && this.config.service) {
			console.log(`Instantiating service provider "${this.config.serviceName}"`);

			// Instantiate
			this.activeService = new this.services[this.config.serviceName]({
				onDisconnect: this.options.onDisconnect
			}, this.getServiceDefaults(this.config.serviceName));

			// Invoke settings validation
			this.activeService.validateServiceSettings(
				this.activeService.serviceValidation,
				this.config.service
			);
		}
	}

	/**
	 * Get the default settings for a service, extended from the base defaults
	 * @param {string} serviceName - Name of the service to retrieve defaults for.
	 */
	getServiceDefaults(serviceName) {
		return Object.assign({},
			ServiceBase.defaults,
			this.services[serviceName].defaults
		);
	}
}

module.exports = Service;
