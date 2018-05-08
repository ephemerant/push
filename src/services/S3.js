// const vscode = require("vscode");
const S3FS = require('s3fs');

const ServiceBase = require('./ServiceBase');
const PathCache = require('../lib/PathCache');

class ServiceS3 extends ServiceBase {
	constructor(options, defaults) {
		super(options, defaults);

		this.type = 'S3';
		this.clients = {};
		this.pathCache = new PathCache();

		this.options.maxClients = 2;

		// Define S3 validation rules
		this.serviceValidation = {
			bucket: true
		};
	}

	/**
	 * Class destructor. Removes all clients.
	 */
	destructor() {
		Object.keys(this.clients).forEach((hash) => {
			this._removeClient(hash);
		});
	}


	/**
	 * Removes a single SFTP client instance by its options hash.
	 * @param {string} hash
	 */
	_removeClient(hash) {
		// TODO:
		// if (this.clients[hash] && this.clients[hash].sftp) {
		// 	channel.appendLocalisedInfo(
		// 		'sftp_disconnected',
		// 		this.clients[hash].options.host,
		// 		this.clients[hash].options.port
		// 	);

		// 	return this.clients[hash].sftp.end()
		// 		.then(() => {
		// 			this.clients[hash] = null;
		// 			delete this.clients[hash];
		// 		});
		// } else {
		// 	return Promise.resolve(false);
		// }
	}
}

module.exports = ServiceS3;