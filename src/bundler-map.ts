import { Bundler } from "./bundle";
import { Deferred } from "./utils";

import type esbuild from "esbuild";
import type { Log } from "./utils";

export class BundlerMap {
	private potentials = new Set<string>();
	private bundlers = new Map<string, Bundler>();
	private declare log: Log;
	private declare config: esbuild.BuildOptions;
	private _dirty = true;
	private deferred = new Deferred<void>();

	constructor(log: Log, config: esbuild.BuildOptions) {
		this.log = log;
		this.config = config;
	}

	async getOrInit(file: string) {
		// Wait for the dirty bit to be synchronized to bundlers.
		await this.deferred.promise;
		return this.getOrInitSync(file);
	}

	// Only called for the testEntryPoint file.
	getOrInitSync(file: string) {
		let bundler = this.bundlers.get(file);
		if (bundler) return bundler;

		bundler = new Bundler(file, this.log, this.config);
		this.bundlers.set(file, bundler);
		this.potentials.delete(file);
		return bundler;
	}

	has(file: string) {
		return this.bundlers.has(file) || this.potentials.has(file);
	}

	dirty() {
		if (this._dirty) return;
		this._dirty = true;
		this.deferred = new Deferred();
	}

	sync() {
		if (!this._dirty) return;
		this._dirty = false;
		this.bundlers.forEach(b => b.dirty());
		this.deferred.resolve();
	}

	stop() {
		const promises = [...this.bundlers.values()].map(b => b.stop());
		return Promise.all(promises);
	}

	addPotential(file: string) {
		if (this.bundlers.has(file)) return;
		this.potentials.add(file);
	}
}
