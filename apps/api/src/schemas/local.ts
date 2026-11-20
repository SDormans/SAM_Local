import * as v from 'valibot';

/** Desktop-supervisor report of host prerequisites (spec 036 LocalRuntimeHealth). */
export const LocalPrerequisitesSchema = v.object({
  dockerDesktop: v.picklist(['ready', 'stopped', 'unavailable']),
  wsl2: v.picklist(['ready', 'unavailable']),
  message: v.optional(v.pipe(v.string(), v.maxLength(500))),
});

export type LocalPrerequisites = v.InferOutput<typeof LocalPrerequisitesSchema>;

const PositiveInt = v.pipe(v.number(), v.integer(), v.minValue(1));

/** Hardware Docker Desktop gives the local node; used as the node's observed capacity. */
export const LocalNodeRegistrationSchema = v.object({
  vcpuCount: v.pipe(PositiveInt, v.maxValue(1024)),
  memoryMb: v.pipe(PositiveInt, v.maxValue(16 * 1024 * 1024)),
  diskGb: v.pipe(PositiveInt, v.maxValue(1024 * 1024)),
});

export type LocalNodeRegistration = v.InferOutput<typeof LocalNodeRegistrationSchema>;
