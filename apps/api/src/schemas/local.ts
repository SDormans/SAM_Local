import * as v from 'valibot';

/** Desktop-supervisor report of host prerequisites (spec 036 LocalRuntimeHealth). */
export const LocalPrerequisitesSchema = v.object({
  dockerDesktop: v.picklist(['ready', 'stopped', 'unavailable']),
  wsl2: v.picklist(['ready', 'unavailable']),
  message: v.optional(v.pipe(v.string(), v.maxLength(500))),
});

export type LocalPrerequisites = v.InferOutput<typeof LocalPrerequisitesSchema>;
