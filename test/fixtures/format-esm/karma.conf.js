const { baseConfig } = require("../../base.karma.conf");

module.exports = function (config) {
	config.set({
		...baseConfig,

		esbuild: {
			format: "esm",
			plugins: [
				{
					name: "externalizer",
					setup(build) {
						build.onResolve({ filter: /./ }, args => {
							if (args.importer === "") return null;
							return { external: true };
						});
					},
				},
			],
		},
	});
};
