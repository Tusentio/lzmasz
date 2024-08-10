#!/usr/bin/env node

import fs from "node:fs";
import posix from "node:path/posix";
import { PassThrough } from "node:stream";

import chalk from "chalk";
import ignore from "ignore";
import lzma from "lzma-native";
import prettyBytes from "pretty-bytes";
import prand from "pure-rand";

const rng = prand.xoroshiro128plus(1861946374);

/** @type {Map<string, Buffer | undefined>} */
const fileCache = new Map();
let cacheSize = 0;

/**
 * @param {string} file
 * @returns {Promise<Buffer | undefined>}
 */
async function cacheFile(file) {
    if (fileCache.has(file)) {
        return fileCache.get(file);
    }

    if (!fs.existsSync(file)) {
        fileCache.set(file, undefined);
        return undefined;
    }

    const buffer = await fs.promises.readFile(file);

    if (buffer.length > 1e9) {
        fileCache.clear();
        cacheSize = 0;
    } else {
        while (cacheSize + buffer.length > 1e9) {
            const key = fileCache.keys().next().value;
            fileCache.delete(key);
            cacheSize -= fileCache.get(key).length;
        }
    }

    fileCache.set(file, buffer);
    return buffer;
}

/**
 *
 * @param {string} path
 * @param {{ base: string, ignore: import("ignore").Ignore }[]} ignores
 */
function ignored(path, ignores) {
    let result = false;

    for (const { base, ignore } of ignores) {
        const relative = posix.relative(base, path);
        const { ignored, unignored } = ignore.test(relative);

        if (unignored) {
            result = false;
        } else if (ignored) {
            result = true;
        }
    }

    return result;
}

/**
 * @param {string} dir
 * @param {{ dir: string, ignore: import("ignore").Ignore }[]} ignores
 * @returns {AsyncGenerator<string>}
 */
async function* walk(dir, ignores = []) {
    dir = posix.normalize(dir);

    const patterns = ((await cacheFile(posix.join(dir, ".lzmaszignore"))) ?? "").toString("utf8").trim();
    if (patterns !== "") {
        const lzmaszignore = ignore().add(patterns);
        ignores = [...ignores, { base: dir, ignore: lzmaszignore }];
    }

    for await (const dirent of await fs.promises.opendir(dir)) {
        const path = posix.join(dir, dirent.name);

        if (dirent.isDirectory()) {
            if (ignored(path + "/", ignores)) continue;
            yield* walk(path, ignores);
        } else if (dirent.isFile()) {
            if (ignored(path, ignores)) continue;
            yield path;
        }
    }
}

/**
 * @param {AllowSharedBufferSource} buffer
 * @returns {boolean}
 */
function isValidUtf8(buffer) {
    try {
        new TextDecoder("utf8", { fatal: true }).decode(buffer);
        return true;
    } catch {
        return false;
    }
}

// Hide cursor
process.stdout.write("\x1B[?25l");

const files = [];
let uncompressedSize = 0;

for await (const file of walk(".")) {
    try {
        const buffer = await cacheFile(file);

        if (isValidUtf8(buffer)) {
            files.push(file);
            uncompressedSize += buffer.length;
            console.log(chalk.dim(`+ ${file}`));
        }
    } catch (error) {
        console.error(chalk.redBright(`- ${file} (${error.message})`));
    }
}

console.log();
console.log(chalk.bold(`${prettyBytes(uncompressedSize)} (${uncompressedSize.toLocaleString()} B)`));

process.stdout.write(chalk.bold("[") + chalk.dim(".".repeat(62)) + chalk.bold("]"));

const compressedSizes = [];

for (let i = 0, start = performance.now(); ; i++) {
    files.sort(() => prand.unsafeUniformIntDistribution(0, 1, rng) - 0.5);

    const input = new PassThrough();
    const output = new PassThrough();

    const compressor = lzma.createCompressor({
        check: lzma.CHECK_NONE,
        threads: 8,
        preset: 9,
    });

    input.pipe(compressor).pipe(output);

    (async () => {
        for (const file of files) {
            const buffer = await cacheFile(file);

            if (!input.write(buffer)) {
                await new Promise((resolve) => input.once("drain", resolve));
            } else {
                await new Promise((resolve) => process.nextTick(resolve));
            }
        }

        input.end();
    })();

    let compressedSize = 0;
    for await (const chunk of output) {
        compressedSize += chunk.length;
    }

    compressedSizes.push(compressedSize);

    const end = performance.now();
    const elapsed = end - start;
    const progress = Math.floor(Math.min(1, elapsed / 3000) * 62);

    process.stdout.write(
        "\x1B[G" + chalk.bold(`[${"#".repeat(progress)}`) + chalk.dim(".".repeat(62 - progress)) + chalk.bold("]")
    );

    if (elapsed > 3000) break;
}

// Clear line
process.stdout.write("\x1B[G\x1B[K");

const compressedSize = compressedSizes.reduce((a, b) => a + b) / compressedSizes.length;
const sd = Math.sqrt(compressedSizes.reduce((a, b) => a + (b - compressedSize) ** 2) / compressedSizes.length);

console.log(
    chalk.bold(
        `${prettyBytes(Math.round(compressedSize))} (${Math.round(compressedSize).toLocaleString()} B) ± ${Math.round(
            sd
        ).toLocaleString()} B compressed`
    )
);
