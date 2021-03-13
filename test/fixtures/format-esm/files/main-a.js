import { foo } from "./dep1.js";

describe("simple", () => {
	it("should work", () => {
		if (!foo().endsWith("/dep1.js")) {
			throw new Error(`Expected "${foo()} to end with "/dep1.js"`);
		}
	});
});
