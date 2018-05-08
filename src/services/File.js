const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const ServiceBase = require('./ServiceBase');
const utils = require('../lib/utils');
const ExtendedStream = require('../lib/ExtendedStream');
const PathCache = require('../lib/PathCache');
const i18n = require('../lang/i18n');

const SRC_REMOTE = PathCache.sources.REMOTE;
const SRC_LOCAL = PathCache.sources.LOCAL;

class File extends ServiceBase {
	constructor(options, defaults) {
		super(options, defaults);

		this.mkDir = this.mkDir.bind(this);

		this.type = 'File';
		this.pathCache = new PathCache();
		this.writeStream = null;
		this.readStream = null;

		// Define File validation rules
		this.serviceValidation = {
			root: true
		};
	}

	init(queueLength) {
		return super.init(queueLength)
			.then(() => {
				return this.pathCache.clear();
			});
	}

	/**
	 * Put a single file to the remote location.
	 * @param {uri} local - Local Uri or Readable stream instance.
	 * @param {uri} remote - Remote Uri.
	 */
	put(local, remote) {
		// Perform transfer from local to remote, setting root as defined by service
		return this.transfer(
			File.transferTypes.PUT,
			local,
			vscode.Uri.file(remote),
			vscode.Uri.file(this.config.service.root),
			'>> ',
			this.config.service.collisionUploadAction
		);
	}

	/**
	 * Get a single file from the remote location.
	 * @param {uri} local - Local Uri.
	 * @param {uri} remote - Remote Uri.
	 */
	// TODO: check the remote file exists and error remote_file_not_found if not
	get(local, remote) {
		// Perform transfer from remote to local, setting root as base of service file
		return this.transfer(
			File.transferTypes.GET,
			vscode.Uri.file(remote),
			local,
			vscode.Uri.file(path.dirname(this.config.serviceFilename)),
			'<< ',
			this.config.service.collisionDownloadAction
		);
	}

	/**
	 * Transfers a single file from location to another.
	 * @param {number} transferType - One of the {@link File.transferTypes} types.
	 * @param {Uri} src - Source Uri.
	 * @param {Uri} dest - Destination Uri.
	 * @param {Uri} root - Root directory. Used for validation.
	 */
	transfer(transferType, src, dest, root, collisionAction) {
		let destPath = this.paths.getNormalPath(dest),
			destDir = path.dirname(destPath),
			destFilename = path.basename(destPath),
			rootDir = this.paths.getNormalPath(root),
			logPrefix = (transferType === File.transferTypes.PUT ? '>> ' : '<< '),
			srcType = (transferType === File.transferTypes.PUT ? SRC_REMOTE : SRC_LOCAL);

		this.setProgress(`${destFilename}...`);

		return this.mkDirRecursive(destDir, rootDir, this.mkDir, ServiceBase.pathSep)
			.then(() => this.getFileStats(dest, src, srcType))
			.then((stats) => super.checkCollision(
				stats.local,
				stats.remote,
				collisionAction
			))
			.then((result) => {
				// Figure out what to do based on the collision (if any)
				if (result === false) {
					// No collision, just keep going
					this.channel.appendLine(`${logPrefix}${destPath}`);
					return this.copy(src, destPath);
				} else {
					this.setCollisionOption(result);

					switch (result.option) {
						case utils.collisionOpts.stop:
							throw utils.errors.stop;

						case utils.collisionOpts.skip:
							return false;

						case utils.collisionOpts.overwrite:
							this.channel.appendLine(`${logPrefix}${destPath}`);
							return this.copy(src, destPath);

						case utils.collisionOpts.rename:
							return this.list(destDir, srcType)
								.then((dirContents) => {
									// Re-invoke transfer with new filename
									destPath = destDir + '/' + this.getNonCollidingName(
										destFilename,
										dirContents
									);

									return this.transfer(
										src,
										destPath,
										rootDir,
										logPrefix
									);
								});
					}

					return false;
				}
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
	 * Effectively stops the read and write streams by end() and destroy().
	 */
	stop() {
		return new Promise((resolve) => {
			// Stop read stream
			if (this.readStream) {
				this.readStream.destroy();
			}

			// Stop write stream
			if (this.writeStream) {
				this.writeStream.end();
				this.writeStream.destroy();
			}

			resolve();
		});
	}

	/**
	 * Recursively creates direcotories up to and including the basename of the given path.
	 * Will reject on an incompatible collision.
	 * @param {string} dest - Destination directory to create
	 */
	mkDir(dir) {
		return this.list(path.dirname(dir))
			.then(() => {
				let existing = this.pathCache.getFileByPath(SRC_REMOTE, dir);

				if (existing === null) {
					return new Promise((resolve, reject) => {
						fs.mkdir(dir, (error) => {
							if (error) {
								reject(error);
							}

							// Add dir to cache
							this.pathCache.addCachedFile(
								SRC_REMOTE,
								dir,
								((new Date()).getTime() / 1000),
								'd'
							);

							resolve();
						});
					});
				} else if (existing.type === 'f') {
					return Promise.reject(new Error(
						i18n.t('directory_not_created_remote_mismatch', dir)
					));
				}
			});
	}

	/**
	 * Return a list of the remote directory.
	 * @param {string} dir - Remote directory to list
	 * @param {string} srcType - One of the {@link PathCache.sources} types.
	 */
	list(dir, srcType = SRC_REMOTE) {
		return this.paths.listDirectory(dir, srcType,  this.pathCache);
	}

	listRecursiveFiles(uri, ignoreGlobs) {
		return this.paths.getDirectoryContentsAsFiles(uri, ignoreGlobs);
	}

	/**
	 * Obtains local/remote stats for a file.
	 * @param {uri} remote - Remote Uri.
	 * @param {uri} local - Local Uri.
	 * @param {uri} srcType - One of the {@link PathCache.sources} types.
	 */
	getFileStats(remote, local, srcType = SRC_REMOTE) {
		const remotePath = this.paths.getNormalPath(remote),
			remoteDir = path.dirname(remotePath);

		return this.list(remoteDir, srcType)
			.then(() => {
				const remoteStat = this.pathCache.getFileByPath(
					SRC_REMOTE,
					remotePath
				);

				let localPath = this.paths.getNormalPath(local),
					localStat = fs.statSync(localPath);

				return {
					local: {
						name: path.basename(localPath),
						modified: (localStat.mtime.getTime() / 1000),
						type: (localStat.isDirectory() ? 'd' : 'f')
					},
					remote: remoteStat
				};
			});
	}

	/**
	 * Copies a file or stream from one location to another.
	 * @param {*} src - Either a source Uri or a readable stream.
	 * @param {string} dest - Destination filename.
	 */
	copy(src, dest) {
		return new Promise((resolve, reject) => {
			function fnError(error) {
				this.stop(() => reject(error));
			};

			// Create write stream & attach events
			this.writeStream = fs.createWriteStream(dest);
			this.writeStream.on('error', fnError.bind(this));
			this.writeStream.on('finish', resolve);

			if (src instanceof vscode.Uri || typeof src === 'string') {
				// Source is a VSCode Uri - create a read stream
				this.readStream = fs.createReadStream(this.paths.getNormalPath(src));
				this.readStream.on('error', fnError.bind(this));
				this.readStream.pipe(this.writeStream);
			} else if (src instanceof ExtendedStream) {
				// Source is already a stream - just pipe to the write stream
				this.readStream = src.read;
				this.readStream.on('error', fnError.bind(this));
				this.readStream.pipe(this.writeStream);
			} else {
				reject(new Error(
					'Source src argument is neither a readable stream or a filename.'
				));
			}
		});
	}
};

File.description = i18n.t('file_class_description');

File.defaults = {
	root: '/'
};

File.transferTypes = {
	PUT: 0,
	GET: 1
};

module.exports = File;