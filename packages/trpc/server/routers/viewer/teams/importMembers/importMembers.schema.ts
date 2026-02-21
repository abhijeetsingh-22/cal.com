import { MAX_NB_INVITES } from "@calcom/lib/constants";
import { emailSchema } from "@calcom/lib/emailSchema";
import { CreationSource, MembershipRole } from "@calcom/prisma/enums";
import { attributeSchema } from "@calcom/trpc/server/routers/viewer/attributes/assignUserToAttribute.schema";
import { z } from "zod";

export const ZImportMembersInputSchema = z.object({
  teamId: z.number(),
  members: z
    .array(
      z.object({
        email: emailSchema,
        role: z.nativeEnum(MembershipRole),
        attributes: attributeSchema.array().optional(),
      })
    )
    .min(1)
    .max(MAX_NB_INVITES)
    .transform((members) => members.map((m) => ({ ...m, email: m.email.trim().toLowerCase() }))),
  language: z.string(),
  creationSource: z.nativeEnum(CreationSource),
});

export type TImportMembersInputSchema = z.infer<typeof ZImportMembersInputSchema>;
