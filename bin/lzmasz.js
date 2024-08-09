#!/usr/bin/env node

import fs from "node:fs/promises";
import { PassThrough } from "node:stream";

import chalk from "chalk";
import Gitignore from "gitignore-fs";
import lzma from "lzma-native";
import prettyBytes from "pretty-bytes";

const gitignore = new Gitignore();

const compressor = lzma.createCompressor({
    check: lzma.CHECK_NONE,
    threads: 8,
    preset: 9,
});

async function* walk(dir) {
    for await (const dirent of await fs.opendir(dir)) {
        const file = `${dir}/${dirent.name}`;
        if (await gitignore.ignores(file)) continue;
        if (dirent.isDirectory()) yield* walk(file);
        else if (dirent.isFile()) yield file;
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
    let total = 0;
    for await (const file of walk(".")) {
        const buffer = await fs.readFile(file);

        if (isValidUTF8(buffer)) {
            console.debug(chalk.blue(`+ ${file}`));
            const padded = Buffer.concat([buffer, Buffer.alloc(1)], buffer.length + 1);
            await new Promise((resolve) => input.write(padded, resolve));
            total += buffer.length;
        }
    }

    input.end();
    console.debug(chalk.blue(`\n${prettyBytes(total)} (${total.toLocaleString()} bytes)`));
})();

let size = 0;
for await (const chunk of output) {
    size += chunk.length;
}

console.log(chalk.bold(`${prettyBytes(size)} (${size.toLocaleString()} bytes) compressed`));
