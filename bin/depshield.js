#!/usr/bin/env node
import { main } from '../src/main.js';

main(process.argv.slice(2)).catch((error) => {
  console.error(`\n✖ ${error.message}`);
  if (process.env.DEBUG) console.error(error.stack);
  process.exitCode = 1;
});
