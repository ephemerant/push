const vscode = require("vscode");
const SFTPClient = require('ssh2-sftp-client');
const ssh = require('ssh2').Client;
const fs = require('fs');
const path = require('path');
const homedir = require('os').homedir;
const micromatch = require("micromatch");

const ServiceBase = require('./ServiceBase');
const utils = require('../lib/utils');
const PathCache = require('../lib/PathCache');
const channel = require('../lib/channel');
const i18n = require('../lang/i18n');

const SRC_REMOTE = PathCache.sources.REMOTE;
// const SRC_LOCAL = PathCache.sources.LOCAL;

class ServiceSFTP extends ServiceBase {
	constructor(options, defaults) {
		super(options, defaults);

		this.mkDir = this.mkDir.bind(this);

		this.type = 'SFTP';
		this.clients = {};
		this.pathCache = new PathCache();
		this.sftpError = null;
		this.globalReject = null;

		this.options.maxClients = 2;
		this.options.modeGlob = {
			basename: true,
			dot: true,
			nocase: true
		};

		// Define SFTP validation rules
		this.serviceValidation = {
			host: true,
			username: true,
			root: true
		};
	}

	/**
	 * Class destructor. Removes all clients.
	 */
	destructor() {
		Object.keys(this.clients).forEach((hash) => {
			this.removeClient(hash);
		});
	}

	/**
	 * @description
	 * Merges the service specific default settings with supplied object.
	 * SFTP variant that also detects and merges SSH gateway settings.
	 * @param {object} settings
	 */
	mergeWithDefaults(settings) {
		let newSettings = Object.assign({}, this.serviceDefaults, settings);

		// If there is a gateway defined, merge that
		if (newSettings.sshGateway) {
			newSettings.sshGateway = Object.assign(
				{},
				ServiceSFTP.gatewayDefaults,
				newSettings.sshGateway
			)
		}

		return newSettings;
	}

	/**
	 * Runs initialisation code (before each queue begins)
	 */
	init(queueLength) {
		return super.init(queueLength)
			.then(() => {
				this.sftpError = null;

				return this.pathCache.clear();
			});
	}

	/**
	 * Sets the current configuration.
	 * @param {object} config
	 */
	setConfig(config) {
		super.setConfig(config);
	}

	/**
	 * Connect to an SSH server, returning a Promise resolving to a client instance.
	 * @returns {promise} - Promise resolving to a connected SFTP client instance.
	 */
	connect() {
		let hash = this.config.serviceSettingsHash;

		return this.getClient(hash)
			.then((client) => {
				if (!client.lastUsed) {
					// New client - connect first
					if (client.gateway) {
						return this.openGatewayConnection(client);
					} else {
						return this.openConnection(client);
					}
				} else {
					// Existing client - just return it
					return Promise.resolve(client.sftp);
				}
			})
			.catch((error) => {
				// Catch the native error and throw a better one
				if (error.code === 'ENOTFOUND' && error.level === 'client-socket') {
					// This is likely the error that means the client couldn't connect
					throw new Error(
						i18n.t(
							'sftp_could_not_connect_server',
							this.config.service.host,
							this.config.service.port
						)
					);
				}

				throw error;
			});
	}

	/**
	 * Attempts to open a connection to the configured SFTP server.
	 * @param {object} client - SFTP client spec returned from {@link this.getClient}.
	 * @param {object} options - SFTP Option overrides.
	 * @return {promise} - Resolving to a connected SFTP instance.
	 */
	openConnection(client, options = {}) {
		return client.sftp.connect(Object.assign({}, client.options, options))
			.then(() => {
				this.onConnect();

				if (client.gateway) {
					channel.appendLocalisedInfo(
						'sftp_client_connected_gateway',
						client.options.host,
						client.options.port,
						client.gatewayOptions.host,
						client.gatewayOptions.port
					);
				} else {
					channel.appendLocalisedInfo(
						'sftp_client_connected',
						client.options.host,
						client.options.port
					);
				}

				return client;
			})
			.then((client) => this.checkServiceRoot(client))
			.catch((error) => this.handleSFTPError(error, client));
	}

	/**
	 * Open a connection to the SFTP server via the defined gateway server.
	 * @param {object} client - SFTP client spec.
	 * @returns {Promise} - Resolving to a connected SFTP instance.
	 */
	openGatewayConnection(client) {
		return new Promise((resolve, reject) => {
			// Set up client gateway and connect to it
			client.gateway
				.on('ready', () => {
					console.log('Gateway connection ready');
					if (client.options.privateKeyFile) {
						// Get the private key file contents from the gateway, then connect
						this.readWithSSH(client.gateway, client.options.privateKeyFile)
							.then((contents) => {
								client.options.privateKey = contents;

								this.connectGatewaySFTP(client)
									.then(resolve, reject);
							})
							.catch((error) => {
								reject(i18n.t(
									'could_not_load_gateway_key',
									client.options.privateKeyFile,
									error.message
								));
							});
					} else {
						// Just connect
						this.connectGatewaySFTP(client)
							.then(resolve, reject);
					}
				})
				.on('error', (error) => {
					this.channel.appendLocalisedError('error_from_gateway', error);
					reject('Gateway SSH error: ' + error.message);
				})
				.connect(client.gatewayOptions);
		});
	}

	/**
	 * Connect to an SFTP server via SSH gateway, resolving the connected SFTP instance.
	 * @param {Object} client - SFTP client spec.
	 * @returns {Promise} - Resolving to a connected SFTP instance.
	 */
	connectGatewaySFTP(client) {
		return new Promise((resolve, reject) => {
			// Connect to the SFTP server (from the gateway)
			client.gateway.forwardOut(
				'127.0.0.1',
				client.gatewayOptions.port,
				client.options.host,
				client.options.port,
				(error, stream) => {
					if (error) {
						client.gateway.end();
						return reject(error);
					}

					this.openConnection(client, {
						host: null,
						port: null,
						sock: stream
					})
						.then(resolve)
						.catch(reject);
				}
			);
		});
	}

	handleSFTPError(error, client) {
		return new Promise((resolve, reject) => {
			if (error.level === 'client-authentication') {
				// Put a note in the log to remind users that a password can be set
				if (client.options.privateKeyFile !== '') {
					// If there was a keyfile yet we're at this point, it might have broken
					channel.appendLocalisedInfo(
						'key_file_not_working',
						client.options.privateKeyFile,
						client.options.username
					);
				}

				this.channel.appendLocalisedInfo('requesting_password');

				// Offer to use a password
				this.requestAuthentication()
					.then((result) => {
						if (result) {
							// Temporarily set the password in the service config
							this.config.service.password = result;
							resolve(this.openConnection(client, client.options));
						} else {
							reject(error);
						}
					});
			} else {
				// This likely ain't happening - let's just ditch the client and reject
				this.destroyClient(client);

				reject(error);
			}
		});
	}

	/**
	 * Attempt to list the root path to ensure it exists
	 * @param {SFTP} client - SFTP client object.
	 * @param {function} resolve - Promise resolver function.
	 */
	checkServiceRoot(client) {
		return client.sftp.list(this.config.service.root)
			.then(() => {
				// Return the sftp object
				return client.sftp;
			})
			.catch(() => {
				throw new Error(
					i18n.t('sftp_missing_root', this.config.settingsFilename)
				);
			});
	}

	/**
	 * Stops any current transfers (by disconnecting all current clients)
	 */
	stop() {
		return this.disconnect();
	}

	/**
	 * Disconnects all current clients.
	 */
	disconnect() {
		let tasks = [], hash;

		this.setProgress(false);

		for (hash in this.clients) {
			tasks.push(
				this.clients[hash].sftp.end()
					.then(() => {
						this.clients[hash] = null;
						delete this.clients[hash];
					})
			);
		}

		return new Promise((resolve) => {
			Promise.all(tasks)
				.then(resolve);
		});
	}

	/**
	 * Ends and then destroys a client's SFTP connection.
	 * @param {object} client - Client connection object.
	 */
	destroyClient(client) {
		if (client.sftp) {
			client.sftp.end();
			client.sftp = null;
		}

		if (client.gateway) {
			client.gateway.end();
			client.gateway = null;
		}
	}

	/**
	 * Returns a Promise eventually resolving to a new client instance, with the addition
	 * of performing cleanup to ensure a maximum number of client instances exist.
	 * @param {string} hash
	 * @returns {promise} - Promise resolving to an SFTP client instance.
	 */
	getClient(hash) {
		let date = new Date(),
			results = [],
			keys;

		return new Promise((resolve) => {
			if (this.clients[hash] && this.clients[hash].sftp) {
				// Return the existing client instance
				this.clients[hash].lastUsed = date.getTime();

				// Resolve with an existing client connection
				resolve(this.clients[hash]);
			} else {
				// Create a new client, removing old ones in case there are too many
				keys = Object.keys(this.clients);

				if (keys.length === this.options.maxClients) {
					// Remove old clients
					keys.sort((a, b) => {
						return this.clients[a].lastUsed - this.clients[b].lastUsed;
					});

					keys.slice(this.options.maxClients - 1).forEach((hash) => {
						results.push(this.removeClient(hash));
					});
				}

				// Wait until all old clients have disconnected
				Promise.all(results)
					.then(() => {
						// Create a new client
						this.clients[hash] = {
							lastUsed: 0,
							sftp: new SFTPClient(),
							options: this.getClientOptions(
								this.config.service,
								!(this.config.service.sshGateway)
							)
						};

						if (this.config.service.sshGateway) {
							// Client is going to connect via a gateway - add its instance here
							this.clients[hash].gatewayOptions = this.getClientOptions(
								this.config.service.sshGateway
							);

							this.clients[hash].gateway = new ssh();
						}

						this.clients[hash].sftp.client
							// .on('keyboard-interactive', (name, instructions, prompts, finish) => {
							// 	console.log('keyboard-interactive event');
							// })
							.on('close', (error) => {
								// Check for local or global error (created by error event)
								let hadError = (error || this.sftpError);

								if (hadError && hadError.level) {
									if (hadError.level === 'client-authentication') {
										// Error is regarding authentication - don't consider fatal
										hadError = false;
									} else {
										hadError = true;
									}
								} else {
									hadError = false;
								}

								// Close SSH gateway connection, if exists
								if (this.clients[hash] && this.clients[hash].gateway) {
									this.clients[hash].gateway.end();
								}

								// Fire onDisconnect event method
								this.onDisconnect(hadError, hash);
							})
							.on('error', (error) => (this.sftpError = error));

						// Resolve with new client connection
						resolve(this.clients[hash]);
					});
			}
		});
	}

	/**
	 * Create an object of SFTP client options, given the service settings.
	 * @param {object} service - Service settings Object.
	 * @param {boolean} validateKey - Whether or not to validate the key file location.
	 */
	getClientOptions(service, validateKey = true) {
		let sshKey,
			options = {
				host: service.host,
				port: service.port,
				username: service.username,
				passphrase: service.keyPassphrase || this.config.privateSSHKeyPassphrase,
				keepaliveInterval: service.keepaliveInterval,
				tryKeyboard: true
			};

		if (validateKey) {
			// Validate key file and convert options
			sshKey = this._getPrivateKey(service);

			options.privateKey = (sshKey && sshKey.contents);
			options.privateKeyFile = (sshKey && sshKey.file);
		} else {
			// Just set the privateKeyFile property
			options.privateKeyFile = service.privateKey;
		}

		// Add a password, if set
		if (service.password) {
			options.password = service.password;
		}

		// Add a debugging logger, if requested
		if (service.debug) {
			options.debug = (data) => {
				channel.appendLine(`SFTP: "${data}"`);
			}
		}

		return options;
	}

	/**
	 * Removes a single SFTP client instance by its options hash.
	 * @param {string} hash
	 */
	removeClient(hash) {
		if (this.clients[hash] && this.clients[hash].sftp) {
			channel.appendLocalisedInfo(
				'sftp_disconnected',
				this.clients[hash].options.host,
				this.clients[hash].options.port
			);

			return this.clients[hash].sftp.end()
				.then(() => {
					this.clients[hash] = null;
					delete this.clients[hash];
				});
		} else {
			return Promise.resolve(false);
		}
	}

	/**
	 * Fired on disconnection of the SFTP client.
	 * @param {boolean} hadError - Whether or not an error occured.
	 * @param {string} hash - SFTP client hash (Generated by service settings).
	 */
	onDisconnect(hadError, hash) {
		// SFTP clients can be disconnected because of a buffer overflow.
		// This is an internal process to SFTP and should not be reported.
		if (hadError) {
			// Run the onDisconnect event
			super.onDisconnect(hadError);

			// If a global rejection function exists, invoke it
			if (typeof this.globalReject === 'function') {
				this.globalReject();
				this.globalReject = null;
			};

			this.removeClient(hash);
		}
	}

	/**
	 * Put a single file to the SFTP server.
	 * @param {uri} local - Local source Uri.
	 * @param {string} remote - Remote destination pathname.
	 * @param {string} [collisionAction] - What to do on file collision. Use one
	 * of the utils.collisionOpts collision actions.
	 */
	put(local, remote, collisionAction) {
		let remoteDir = path.dirname(remote),
			remoteFilename = path.basename(remote),
			localPath = this.paths.getNormalPath(local);

		collisionAction = collisionAction ||
			this.config.service.collisionUploadAction;

		this.setProgress(`${remoteFilename}...`);

		return this.connect().then(() => {
			return this.mkDirRecursive(
				remoteDir,
				this.config.service.root,
				this.mkDir
			);
		})
		.then(() => {
			return this.getFileStats(remote, local);
		})
		.then((stats) => {
			return super.checkCollision(
				stats.local,
				stats.remote,
				collisionAction
			);
		})
		.then((result) => {
			// Figure out what to do based on the collision (if any)
			if (result === false) {
				// No collision, just keep going
				this.channel.appendLine(`>> ${remote}`);
				return this.clientPut(localPath, remote);
			} else {
				this.setCollisionOption(result);

				switch (result.option) {
					case utils.collisionOpts.stop:
						throw utils.errors.stop;

					case utils.collisionOpts.skip:
						return false;

					case utils.collisionOpts.overwrite:
						this.channel.appendLine(`>> ${remote}`);
						return this.clientPut(localPath, remote);

					case utils.collisionOpts.rename:
						return this.list(remoteDir)
							.then((dirContents) => {
								let remotePath = remoteDir + '/' + this.getNonCollidingName(
										remoteFilename,
										dirContents
									);

								return this.put(
									local,
									remotePath
								);
							});

				}

				return false;
			}
		})
		.then((result) => {
			if (result !== false) {
				return this.setRemotePathMode(remote, this.config.service.fileMode)
					.then(() => result);
			}

			return result;
		})
		.then((result) => {
			this.setProgress(false);
			return result;
		})
		.catch((error) => {
			this.setProgress(false);
			throw error;
		});
	}

	/**
	 * @param {uri} local - Local destination Uri.
	 * @param {string} remote - Remote source filename.
	 * @param {string} [collisionAction] - What to do on file collision. Use one
	 * of the utils.collisionOpts collision actions.
	 * @description
	 * Get a single file from the SFTP server.
	 */
	get(local, remote, collisionAction) {
		let localPath = this.paths.getNormalPath(local),
			remoteDir = path.dirname(remote),
			remoteFilename = path.basename(remote);

		collisionAction = collisionAction ||
			this.config.service.collisionDownloadAction;

		this.setProgress(`${remoteFilename}...`);

		return this.connect()
			.then(() => {
				// List the source directory in order to cache the file data
				return this.list(remoteDir)
					.catch((error) => {
						throw new Error(
							i18n.t('cannot_list_directory', remoteDir, error.message)
						);
					});
			})
			.then(() => this.getFileStats(remote, local))
			.then((stats) => {
				if (!stats.remote) {
					throw(i18n.t('remote_file_not_found', remote));
				}

				return super.checkCollision(
					stats.remote,
					stats.local,
					collisionAction
				);
			})
			.then((result) => {
				// Figure out what to do based on the collision (if any)
				let localDir, localFilename;

				if (result === false) {
					// No collision, just keep going
					this.channel.appendLine(`<< ${localPath}`);
					return this.clientGetByStream(localPath, remote);
				} else {
					this.setCollisionOption(result);

					switch (result.option) {
						case utils.collisionOpts.stop:
							throw utils.errors.stop;

						case utils.collisionOpts.skip:
						case undefined:
							return false;

						case utils.collisionOpts.overwrite:
							this.channel.appendLine(`<< ${localPath}`);
							return this.clientGetByStream(localPath, remote);

						case utils.collisionOpts.rename:
							localDir = path.dirname(localPath);
							localFilename = path.basename(localPath);

							return this.paths.listDirectory(localDir)
								.then((dirContents) => {
									let localPath = localDir + '/' + this.getNonCollidingName(
											localFilename,
											dirContents
										);
									this.channel.appendLine(`<< ${localPath}`);

									return this.clientGetByStream(
										localPath,
										remote
									);
								});

					}

					return false;
				}
			})
			.catch((error) => {
				console.log(`error! ${error.message || error}`);
				this.setProgress(false);
				throw(error);
			});
	}

	/**
	 * Reads a file and returns its contents.
	 * @param {SSH2Client} ssh - A connected instance of SSH2Client.
	 * @returns {Promise} resolving to the file's contents.
	 */
	readWithSSH(ssh, fileName) {
		return new Promise((resolve, reject) => {
			// Get sftp submodule
			ssh.sftp((err, sftp) => {
				if (err) {
					return reject(err);
				}

				// Open the file for reading
				sftp.open(fileName, 'r', (err, fd) => {
					if (err) {
						return reject(err);
					}

					// Use the file descriptor to stat the file
					sftp.fstat(fd, (err, stat) => {
						let offset = 0,
							length = stat.size,
							totalBytesRead = 0,
							bytesRead = 0,
							contents = '',
							buffer = new Buffer(length);

						// Read the file, then resolve its contents
						sftp.read(
							fd,
							buffer,
							offset,
							length,
							bytesRead,
							(error, bytesRead, buffer/*, position*/) => {
								totalBytesRead += bytesRead;

								contents += buffer.toString('utf8');

								// The whole file has been read - resolve
								if (totalBytesRead === length) {
									resolve(contents);
								}
							}
						);
					});
				});
			});
		});
	}

	setRemotePathMode(remote, mode) {
		return new Promise((resolve, reject) => {
			let modeMatch;

			if (Array.isArray(mode)) {
				try {
					modeMatch = this.config.service.fileMode.filter((match) =>
						micromatch.isMatch(remote, match.glob, this.options.modeGlob)
					);
				} catch(e) { reject(e); }


				if (modeMatch.length) {
					mode = modeMatch[0].mode;
				}
			}

			if (mode !== '' && typeof mode === 'string' && mode.length >= 3) {
				// Set mode and resolve
				return this.connect().then((client) => {
					try {
						client.sftp.chmod(remote, mode, resolve);
					} catch(e) {
						reject(e);
					}
				});
			} else {
				// Just resolve
				resolve();
			}
		});
	}

	clientPut(local, remote) {
		return new Promise((resolve, reject) => {
			this.globalReject = reject;

			this.connect().then((client) => {
				client.put(local, remote)
					.then(resolve)
					.catch((error) => {
						reject(new Error(`${remote}: ${error.message}`));
					});
			});
		});
	}

	/**
	 * Retrieves a file from the server using its get stream method.
	 * @param {string} local - Local pathname.
	 * @param {string} remote - Remote pathname.
	 */
	clientGetByStream(local, remote) {
		let client;

		return this.connect()
			.then((connection) => {
				client = connection;
			})
			.then(() => {
				return this.paths.ensureDirExists(path.dirname(local));
			})
			.then(() => {
				return this.getMimeCharset(remote);
			})
			.then((charset) => {
				return new Promise((resolve, reject) => {
					// Get file with client#get and stream to local pathname
					this.globalReject = reject;

					client.get(remote, true, charset === 'binary' ? null : 'utf8')
						.then((stream) => {
							utils.writeFileFromStream(stream, local, remote)
								.then(resolve, reject)
						})
						.catch((error) => {
							throw new Error(`${remote}: ${error && error.message}`);
						});
				});
			});
	}

	/**
	 * Creates a single directory at the specified remote destination.
	 * Will reject on an incompatible collision.
	 * @param {string} dir - Destination directory to create
	 */
	mkDir(dir) {
		return this.connect().then((connection) => {
			return this.list(path.dirname(dir))
				.then(() => {
					let existing = this.pathCache.getFileByPath(SRC_REMOTE, dir);

					if (existing === null) {
						return connection.mkdir(dir)
							.then(() => {
								// Change path mode
								return this.setRemotePathMode(
									this.paths.addTrailingSlash(dir),
									this.config.service.fileMode
								);
							})
							.then(() => {
								// Add dir to cache
								this.pathCache.addCachedFile(
									SRC_REMOTE,
									dir,
									((new Date()).getTime() / 1000),
									'd'
								);
							});
					} else if (existing.type === 'f') {
						return Promise.reject(
							i18n.t('directory_not_created_remote_mismatch', dir)
						);
					}
				});
		})
		.catch((error) => {
			throw error;
		});
	}

	/**
	 * Return a list of the remote directory.
	 * @param {string} dir - Remote directory to list
	 * @param {string} ignoreGlobs - List of globs to ignore.
	 */
	list(dir, ignoreGlobs) {
		if (this.pathCache.dirIsCached(SRC_REMOTE, dir)) {
			// Retrieve cached path list
			// TODO: Allow ignoreGlobs option on this route
			return Promise.resolve(this.pathCache.getDir(SRC_REMOTE, dir));
		} else {
			// Get path list interactively and cache
			return this.connect()
				.then((connection) => {
					return connection.list(dir)
						.then((list) => {
							list.forEach((item) => {
								let match,
									pathName = utils.addTrailingSeperator(dir) + item.name;

								if (ignoreGlobs && ignoreGlobs.length) {
									match = micromatch([pathName], ignoreGlobs);
								}

								if (!match || !match.length) {
									this.pathCache.addCachedFile(
										SRC_REMOTE,
										pathName,
										(item.modifyTime / 1000),
										(item.type === 'd' ? 'd' : 'f')
									);
								}
							});

							return this.pathCache.getDir(SRC_REMOTE, dir);
						});
				});
		}
	}

	/**
	 * @param {string} dir - Directory to list.
	 * @param {string} ignoreGlobs - List of globs to ignore.
	 * @description
	 * Returns a promise either resolving to a recursive file list in the format
	 * given by {@link PathCache#getRecursiveFiles}, or rejects if `dir` is not
	 * found.
	 * @returns {promise}
	 */
	listRecursiveFiles(dir, ignoreGlobs) {
		let counter = {
			scanned: 0,
			total: 0
		};

		return new Promise((resolve, reject) => {
			this.cacheRecursiveList(dir, counter, ignoreGlobs, () => {
				if (counter.scanned === counter.total) {
					resolve(this.pathCache.getRecursiveFiles(
						PathCache.sources.REMOTE,
						dir
					));
				}
			}).catch(reject)
		});
	}

	/**
	 * Recursively adds a directory to the pathCache cache.
	 * @param {string} dir - Directory path
	 * @param {object} counter - Counter object. Must contain `total` and `scanned`
	 * properties with `0` number values.
	 * @param {array} ignoreGlobs - An optional array of globs to ignore
	 * @param {function} callback - An optional callback function to fire when all
	 * of the listed directories have been cached.
	 */
	cacheRecursiveList(dir, counter, ignoreGlobs, callback) {
		if (counter.total === 0) {
			// Ensure counter total starts at 1 (to include the current directory)
			counter.total = 1;
		}

		return this.list(dir, ignoreGlobs)
			.then((dirContents) => {
				let dirs;

				counter.scanned += 1;

				if (dirContents !== null) {
					dirs = dirContents.filter((file) => {
						return (file.type === 'd');
					});

					counter.total += dirs.length;

					dirs.forEach((file) => {
						this.cacheRecursiveList(
							dir + '/' + file.name,
							counter,
							ignoreGlobs,
							callback
						);
					});
				}

				callback(counter);
			});
	}

	/**
	 * Obtains local/remote stats for a file.
	 * @param {string} remote - Remote pathname.
	 * @param {uri} local - Local Uri.
	 */
	getFileStats(remote, local) {
		const remoteDir = path.dirname(remote);

		let result = {};

		return this.list(remoteDir)
			.then(() => {
				return new Promise((resolve) => {
					const localPath = this.paths.getNormalPath(local);

					fs.stat(localPath, (error, stat) => {
						if (!error && stat) {
							result.local = {
								name: path.basename(localPath),
								modified: (stat.mtime.getTime() / 1000),
								type: (stat.isDirectory() ? 'd' : 'f')
							};


						} else {
							result.local = null;
						}

						resolve();
					});
				});
			})
			.then(() => {
				result.remote = this.pathCache.getFileByPath(
					SRC_REMOTE,
					remote
				);

				return result;
			})
			.catch((error) => {
				throw new Error(
					i18n.t('cannot_list_directory', remoteDir, error.message)
				);
			})
	}

	/**
	 * @param {string} file - Remote file to test.
	 * @description
	 * Retrieves the mime data from a file. Uses the `file` command on an SFTP server.
	 * Falls back to extension based checking.
	 */
	getMimeCharset(file) {
		return this.connect().then((connection) => {
			return new Promise((resolve, reject) => {
				connection.client.exec(`file --mime ${file}`, (error, stream) => {
					let totalData = '', totalErrorData = '';

					if (error) {
						reject(error);
					}

					stream.on('close', (code) => {
						let charsetMatch = totalData.match(/charset=([^\s\n]+)/);

						if (totalErrorData ||
							!totalData ||
							charsetMatch === null ||
							code !== 0) {
							resolve(this.getBasicMimeCharset(file));
						} else {
							resolve(charsetMatch[1]);
						}
					}).on('data', (data) => {
						totalData += data;
					}).stderr.on('data', (data) => {
						totalErrorData += data;
					});
				});
			});
		});
	}

	/**
	 * Performs a basic check for charset based on file extension alone.
	 * @param {string} file - Remote file to test.
	 */
	getBasicMimeCharset(file) {
		const ext = path.extname(file);

		if (ServiceSFTP.encodingByExtension.utf8.indexOf(ext) !== -1) {
			return 'utf8';
		}

		return 'binary';
	}

	/**
	 * Used on failure to disconnect, will attempt to ask the user for a psssword.
	 */
	requestAuthentication() {
		return vscode.window.showInputBox({
			ignoreFocusOut: true,
			password: true,
			prompt: i18n.t('sftp_enter_ssh_pass')
		});
	}

	/**
	 * Retrieves the contents of a private key. Will fall back to the current home
	 * folder if no path is specified.
	 * @param {string} file
	 */
	_getPrivateKey(service) {
		let keyFile, homeDir, defaultKeyFiles, a;

		keyFile = String(
			// TODO: get the right private key for gateway SFTP
			(service && service.privateKey) ||
			this.config.privateSSHKey ||
			''
		).trim();

		if (fs.existsSync(keyFile)) {
			return {
				'file': keyFile,
				'contents': fs.readFileSync(keyFile, 'UTF-8')
			};
		} else if (keyFile !== '') {
			// File doesn't exist and wasn't empty
			channel.appendLocalisedError('key_file_not_found', keyFile);
			return false;
		}

		// Fall back to attempting to find by default
		homeDir = homedir();
		defaultKeyFiles = [
			homeDir + '/.ssh/identity',
			homeDir + '/.ssh/id_dsa',
			homeDir + '/.ssh/id_rsa',
		];

		for (a = 0; a < defaultKeyFiles.length; a += 1) {
			if (fs.existsSync(defaultKeyFiles[a])) {
				// Save privateKey location for session...
				service.privateKey = defaultKeyFiles[a];

				// ... Then return
				return {
					'file': defaultKeyFiles[a],
					'contents': fs.readFileSync(defaultKeyFiles[a], 'UTF-8')
				};
			}
		}
	}
};

ServiceSFTP.description = i18n.t('sftp_class_description');

ServiceSFTP.defaults = {
	host: '',
	port: 22,
	username: '',
	password: '',
	privateKey: '',
	keyPassphrase: '',
	root: '/',
	keepaliveInterval: 3000,
	debug: false,
	fileMode: '',
	sshGateway: null
};

ServiceSFTP.gatewayDefaults = {
	host: '',
	port: 22,
	username: '',
	password: '',
	privateKey: '',
	keyPassphrase: '',
	keepaliveInterval: 3000,
	debug: false
};

ServiceSFTP.encodingByExtension = {
	'utf8': [
		'.txt', '.html', '.shtml', '.js', '.jsx', '.css', '.less', '.sass',
		'.php', '.asp', '.aspx', '.svg', '.sql', '.rb', '.py', '.log', '.sh', '.bat',
		'.pl', '.cgi', '.htaccess'
	]
};

module.exports = ServiceSFTP;
