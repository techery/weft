import { checkScope } from "@techery/weft-isolation";
import { describe, expect, test } from "vitest";

describe("write-scope matching", () => {
  test("an exclusion actually excludes", () => {
    // picomatch's own array semantics report src/secret.ts as a match here.
    const { inScope, outOfScope } = checkScope(["src/x.ts", "src/secret.ts"], {
      paths: ["src/**", "!src/secret.ts"],
    });
    expect(inScope).toEqual(["src/x.ts"]);
    expect(outOfScope).toEqual(["src/secret.ts"]);
  });

  test("order of inclusion and exclusion does not matter", () => {
    const { inScope } = checkScope(["src/x.ts", "src/secret.ts"], {
      paths: ["!src/secret.ts", "src/**"],
    });
    expect(inScope).toEqual(["src/x.ts"]);
  });

  test("a scope of only exclusions grants nothing", () => {
    // Previously this matched every path in the repository.
    const { inScope, outOfScope } = checkScope(["anything.ts", "secrets/key.pem"], {
      paths: ["!secrets/**"],
    });
    expect(inScope).toEqual([]);
    expect(outOfScope).toEqual(["anything.ts", "secrets/key.pem"]);
  });

  test("an exclusion in `also` still excludes", () => {
    const { inScope } = checkScope(["dist/app.js", "dist/.secret"], {
      paths: ["src/**"],
      also: ["dist/**", "!dist/.secret"],
    });
    expect(inScope).toEqual(["dist/app.js"]);
  });

  test("decomposed and composed unicode names are the same name", () => {
    const nfd = "café.txt";
    const nfc = "café.txt";
    expect(checkScope([nfd], { paths: [nfc] }).inScope).toEqual([nfd]);
    expect(checkScope([nfc], { paths: [nfd] }).inScope).toEqual([nfc]);
    expect(checkScope([nfd], { paths: ["*.txt"] }).inScope).toEqual([nfd]);
  });

  test("a newline in a filename does not fall out of its own directory", () => {
    const weird = "src/we\nird.txt";
    expect(checkScope([weird], { paths: ["src/**"] }).inScope).toEqual([weird]);
    expect(checkScope([weird], { paths: ["other/**"] }).outOfScope).toEqual([weird]);
  });

  test("traversal and empty scopes stay fail-closed", () => {
    expect(checkScope(["src/../etc/passwd"], { paths: ["src/**"] }).outOfScope).toEqual([
      "src/../etc/passwd",
    ]);
    expect(checkScope(["a.ts"], { paths: [] }).outOfScope).toEqual(["a.ts"]);
  });
});
