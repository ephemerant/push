class ServiceInterface {
	/**
	 * Run intial tasks - executed once before a subsequent commands in a new queue.
	 */
	init() {

	}

	/**
	 * Interface service file upload method.
	 * @param {string} src - File source path
	 * @param {string} dest - File destination path
	 * @param {string} [collisionAction] - What to do on file collision. Use one
	 * of the utils.collisionOpts collision actions.
	 * @returns {promise}
	 */
	put() {
		throw new Error('Service #put method is not yet implemented!');
	}

	/**
	 * Interface service file download method.
	 * @param {string} src - File source path
	 * @param {string} dest - File destination path
	 * @param {string} [collisionAction] - What to do on file collision. Use one
	 * of the utils.collisionOpts collision actions.
	 * @returns {promise}
	 */
	get() {
		throw new Error('Service #get method is not yet implemented!');
	}

	/**
	 * @param {string} dir - Directory to list.
	 * @description
	 * Interface service directory listing method.
	 * Should return a promise either resolving to a list in the format given by
	 * {@link PathCache#getDir}, or rejecting if the directory passed could not be found.
	 * @returns {promise}
	 */
	list() {
		throw new Error('Service #list method is not yet implemented!');
	}

	/**
	 * @description
	 * Interface service stop function. Implementation is optional.
	 *
	 * Used to ensure that an existing transfer is halted.
	 */
	stop() {
		this.setProgress(false);
		return Promise.resolve();
	}

	/**
	 * @description
	 * Interface service disconnect function. Implementation is optional, but it may
	 * be used in the future for preventing hanging connections over time.
	 *
	 * It is the responsibility of the service implementation to ensure all its
	 * active connections are removed.
	 */
	disconnect() { }

	/**
	 * @param {uri} uri - VSCode URI to perform replacement on.
	 * @description
	 * Converts a local path to a remote path given the local `uri` Uri object.
	 *
	 * Implementation is optional, a base definition is defined in ServiceBase.
	 */
	convertUriToRemote() { }

	/**
	 * @param {string} file - Remote pathname to perform replacement on.
	 * @returns {uri} A qualified Uri object.
	 * @description
	 * Converts a remote path to a local path given the remote `file` pathname.
	 *
	 * Implementation is optional, a base definition is defined in ServiceBase.
	 */
	convertRemoteToUri() { }
};

module.exports = ServiceInterface;