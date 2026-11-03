import { prepareBackup } from '../steps.mjs';

export async function run(drill, ctx) {
  await prepareBackup(drill, ctx);
}
