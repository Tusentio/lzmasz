#!/usr/bin/env node

import fs from "node:fs/promises";
import { PassThrough } from "node:stream";

import Gitignore from "gitignore-fs";
const gitignore = new Gitignore();

import lzma from "lzma-native";
const compressor = lzma.createCompressor({
    check: lzma.CHECK_NONE,
    threads: 8,
    preset: 9,
});

import prettyBytes from "pretty-bytes";
import chalk from "chalk";

async function* walk(dir) {
    for await (const dirent of await fs.opendir(dir)) {
        if (await gitignore.ignores(dirent.path)) continue;
        if (dirent.isDirectory()) yield* walk(dirent.path);
        else if (dirent.isFile()) yield dirent.path;
    }
}

function isValidUTF8(buffer) {
    try {
        new TextDecoder("utf-8", { fatal: true }).decode(buffer);
        return true;
    } catch {
        return false;
    }
}

const input = new PassThrough();
const output = new PassThrough();
input.pipe(compressor).pipe(output);

(async () => {
    for await (const file of walk(".")) {
        const buffer = await fs.readFile(file);

        if (isValidUTF8(buffer)) {
            console.debug(chalk.gray(`+ ${file}`));
            const padded = Buffer.concat([buffer, Buffer.alloc(1)], buffer.length + 1);
            await new Promise((resolve) => input.write(padded, resolve));
        }
    }

    input.end();
})();

let size = 0;
for await (const chunk of output) {
    size += chunk.length;
}

console.log(chalk.bold(`${prettyBytes(size)} (${size.toLocaleString()} bytes)`));
