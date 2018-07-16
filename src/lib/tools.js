module.exports = {
	/**
	 * Returns an array with only unique values.
	 * @param {array} arrayData - The array to process
	 */
	uniqArray: function (arrayData) {
		return arrayData.filter((e, i, a) => {
			return (a.indexOf(e) === i);
		});
	},
	/**
	 * Expands Windows Environment Path Variables within a path
	 * @param {string} path - The path to process
	 */
	expandEnvironmentVariables: function (path) {
		return path.replace(/%([^%]+)%/g, function (match, group) {
			return process.env[group] || match;
		});
	}
};