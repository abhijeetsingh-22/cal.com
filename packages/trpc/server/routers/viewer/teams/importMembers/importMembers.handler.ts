import { PermissionCheckService } from "@calcom/features/pbac/services/permission-check.service";
import { checkRateLimitAndThrowError } from "@calcom/lib/checkRateLimitAndThrowError";
import { MembershipRole } from "@calcom/prisma/enums";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import { TRPCError } from "@trpc/server";
import { inviteMembersWithNoInviterPermissionCheck } from "../inviteMember/inviteMember.handler";
import {
  ensureAtleastAdminPermissions,
  findUsersWithInviteStatus,
  getTeamOrThrow,
  getUniqueInvitationsOrThrowIfEmpty,
  INVITE_STATUS,
} from "../inviteMember/utils";
import type { TImportMembersInputSchema } from "./importMembers.schema";
import type { ImportInvitation } from "./utils";
import { ensureBillingAllowsImport, ensureCanGrantOwnerRole, handleRoleAndAttributeUpdates } from "./utils";

type ImportMembersOptions = {
  ctx: { user: NonNullable<TrpcSessionUser> };
  input: TImportMembersInputSchema;
};

export default async function importMembersHandler({ ctx, input }: ImportMembersOptions) {
  const { user: inviter } = ctx;

  await checkRateLimitAndThrowError({ identifier: `importMembersBy:${inviter.id}` });

  const team = await getTeamOrThrow(input.teamId);

  const permissionCheckService = new PermissionCheckService();
  const hasPermission = await permissionCheckService.checkPermission({
    userId: inviter.id,
    teamId: team.id,
    permission: "team.invite",
    fallbackRoles: [MembershipRole.OWNER, MembershipRole.ADMIN],
  });
  if (!hasPermission) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You are not authorized to import members",
    });
  }

  const isTeamAnOrg = team.isOrganization;

  const invitations: ImportInvitation[] = input.members.map((m) => ({
    usernameOrEmail: m.email,
    role: m.role,
    attributes: m.attributes,
  }));

  const inviterOrgId = inviter.organization.id;
  await ensureAtleastAdminPermissions({
    userId: inviter.id,
    teamId: inviterOrgId && inviter.organization.isOrgAdmin ? inviterOrgId : input.teamId,
    isOrg: isTeamAnOrg,
  });

  const organization = inviter.profile.organization;
  const orgSlug = organization ? organization.slug || organization.requestedSlug : null;

  // Classify users before billing and OWNER checks so we can skip
  // those checks when the import only updates existing members
  const uniqueInvitations = await getUniqueInvitationsOrThrowIfEmpty(invitations);
  const existingUsers = await findUsersWithInviteStatus({ invitations: uniqueInvitations, team });
  const existingMembersToUpdate = existingUsers
    .filter((u) => u.canBeInvited === INVITE_STATUS.USER_ALREADY_INVITED_OR_MEMBER)
    .map((u) => ({ id: u.id, email: u.email, username: u.username, newRole: u.newRole }));

  await ensureBillingAllowsImport({
    existingUsers,
    uniqueInvitations,
    team: { id: team.id, parentId: team.parentId },
    language: input.language,
  });

  await ensureCanGrantOwnerRole({
    existingUsers,
    uniqueInvitations,
    teamId: team.id,
    isTeamAnOrg,
    inviterId: inviter.id,
  });

  const inviteResult = await inviteMembersWithNoInviterPermissionCheck({
    inviterName: inviter.name,
    team,
    language: input.language,
    creationSource: input.creationSource,
    orgSlug,
    invitations,
    isDirectUserAction: false,
  });

  const { numUsersUpdated, numUpdatesFailed } = await handleRoleAndAttributeUpdates({
    existingMembersToUpdate,
    invitations,
    teamId: team.id,
    isOrg: isTeamAnOrg,
  });

  return {
    numUsersInvited: inviteResult.numUsersInvited,
    numUsersUpdated,
    numUpdatesFailed,
  };
}
