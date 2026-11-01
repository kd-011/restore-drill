import { prepareBackup } from '../steps.mjs';

/** Newest matching file exists, is non-empty, recent and not suspiciously smaller than last time. */
export async function run(drill, ctx) {
  await prepareBackup(drill, ctx);
}
