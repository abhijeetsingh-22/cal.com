import { DueInvoiceService } from "@calcom/features/ee/billing/service/dueInvoice/DueInvoiceService";
import { isOrganisationOwner } from "@calcom/features/pbac/utils/isOrganisationAdmin";
import logger from "@calcom/lib/logger";
import { safeStringify } from "@calcom/lib/safeStringify";
import { prisma } from "@calcom/prisma";
import type { Membership } from "@calcom/prisma/client";
import { MembershipRole } from "@calcom/prisma/enums";
import { TRPCError } from "@trpc/server";
import { processUserAttributes } from "../../attributes/attributeUtils";
import type { Invitation } from "../inviteMember/utils";
import { INVITE_STATUS } from "../inviteMember/utils";

const log = logger.getSubLogger({ prefix: ["importMembers.utils"] });

export type ImportInvitation = Invitation & {
  attributes?: Array<{
    id: string;
    value?: string;
    options?: Array<{ value: string; weight?: number }>;
  }>;
};

export async function ensureBillingAllowsImport({
  existingUsers,
  uniqueInvitations,
  team,
  language,
}: {
  existingUsers: Array<{ canBeInvited: INVITE_STATUS }>;
  uniqueInvitations: ImportInvitation[];
  team: { id: number; parentId: number | null };
  language: string;
}): Promise<void> {
  const addsNewSeats =
    existingUsers.length < uniqueInvitations.length ||
    existingUsers.some((u) => u.canBeInvited === INVITE_STATUS.CAN_BE_INVITED);
  if (!addsNewSeats) return;

  const dueInvoiceService = new DueInvoiceService();
  const canInvite = await dueInvoiceService.canInviteToTeam({
    teamId: team.id,
    inviteeEmails: uniqueInvitations.map((inv) => inv.usernameOrEmail),
    isSubTeam: !!team.parentId,
    parentOrgId: team.parentId,
  });

  if (!canInvite.allowed) {
    const { getTranslation } = await import("@calcom/lib/server/i18n");
    const translation = await getTranslation(language ?? "en", "common");
    throw new TRPCError({
      code: "FORBIDDEN",
      message: translation(canInvite.reason ?? "invitations_blocked_unpaid_invoice"),
    });
  }
}

export async function ensureCanGrantOwnerRole({
  existingUsers,
  uniqueInvitations,
  teamId,
  isTeamAnOrg,
  inviterId,
}: {
  existingUsers: Array<{
    email: string;
    canBeInvited: INVITE_STATUS;
    teams?: Array<Pick<Membership, "teamId" | "role">>;
  }>;
  uniqueInvitations: Array<Pick<ImportInvitation, "usernameOrEmail" | "role">>;
  teamId: number;
  isTeamAnOrg: boolean;
  inviterId: number;
}): Promise<void> {
  if (!isTeamAnOrg) return;

  const existingUsersByEmail = new Map(existingUsers.map((u) => [u.email, u]));
  const grantsOwner = uniqueInvitations.some((inv) => {
    if (inv.role !== MembershipRole.OWNER) return false;

    const existingUser = existingUsersByEmail.get(inv.usernameOrEmail);
    if (!existingUser) return true;
    if (existingUser.canBeInvited === INVITE_STATUS.CAN_BE_INVITED) return true;
    if (existingUser.canBeInvited === INVITE_STATUS.USER_ALREADY_INVITED_OR_MEMBER) {
      const currentMembership = existingUser.teams?.find((t) => t.teamId === teamId);
      return currentMembership?.role !== MembershipRole.OWNER;
    }
    return false;
  });
  if (!grantsOwner) return;

  const isInviterOrgOwner = await isOrganisationOwner(inviterId, teamId);
  if (!isInviterOrgOwner) throw new TRPCError({ code: "UNAUTHORIZED" });
}

export async function handleExistingMemberRoleUpdates({
  existingMembersToUpdate,
  teamId,
}: {
  existingMembersToUpdate: Array<{
    id: number;
    email: string;
    username: string | null;
    newRole: MembershipRole;
  }>;
  teamId: number;
}): Promise<number[]> {
  const myLog = log.getSubLogger({ prefix: ["handleExistingMemberRoleUpdates"] });

  myLog.debug(
    "Updating existing members",
    safeStringify({
      existingMembersToUpdate,
      teamId,
    })
  );

  if (existingMembersToUpdate.length === 0) {
    return [];
  }

  const memberIds = existingMembersToUpdate.map((m) => m.id);

  const existingMemberships = await prisma.membership.findMany({
    where: {
      userId: { in: memberIds },
      teamId,
    },
    select: {
      userId: true,
      role: true,
    },
  });

  const currentRoleByUserId = new Map(existingMemberships.map((m) => [m.userId, m.role]));

  const membersToUpdate = existingMembersToUpdate.filter((member) => {
    const currentRole = currentRoleByUserId.get(member.id);
    return currentRole && currentRole !== member.newRole;
  });

  if (membersToUpdate.length === 0) {
    myLog.debug("No role changes needed");
    return [];
  }

  const membersByTargetRole = new Map<MembershipRole, number[]>();
  for (const member of membersToUpdate) {
    const existing = membersByTargetRole.get(member.newRole);
    if (existing) {
      existing.push(member.id);
    } else {
      membersByTargetRole.set(member.newRole, [member.id]);
    }
  }

  await prisma.$transaction(
    Array.from(membersByTargetRole.entries()).map(([role, userIds]) =>
      prisma.membership.updateMany({
        where: {
          userId: { in: userIds },
          teamId,
        },
        data: {
          role,
        },
      })
    )
  );

  myLog.debug(`Successfully updated ${membersToUpdate.length} existing members`);

  return membersToUpdate.map((m) => m.id);
}

export async function handleAttributeAssignment({
  invitations,
  teamId,
}: {
  invitations: ImportInvitation[];
  teamId: number;
}): Promise<{ assignedUserEmails: string[]; numFailed: number }> {
  const myLog = log.getSubLogger({ prefix: ["handleAttributeAssignment"] });

  const invitationsWithAttributes = invitations.filter((inv) => inv.attributes?.length);

  if (invitationsWithAttributes.length === 0) {
    return { assignedUserEmails: [], numFailed: 0 };
  }

  const allAttributeIds = Array.from(
    new Set(invitationsWithAttributes.flatMap((inv) => (inv.attributes ?? []).map((a) => a.id)))
  );

  const validAttributes = await prisma.attribute.findMany({
    where: {
      id: { in: allAttributeIds },
      teamId,
    },
    select: {
      id: true,
      type: true,
    },
  });

  const validAttributeMap = new Map(validAttributes.map((a) => [a.id, a.type]));

  const invitationEmails = invitationsWithAttributes.map((inv) => inv.usernameOrEmail);
  const users = await prisma.user.findMany({
    where: {
      email: { in: invitationEmails },
    },
    select: {
      id: true,
      email: true,
    },
  });

  const emailToUserId = new Map(users.map((u) => [u.email, u.id]));

  const results = await Promise.all(
    invitationsWithAttributes.map(async (invitation) => {
      const userId = emailToUserId.get(invitation.usernameOrEmail);
      if (!userId) {
        myLog.warn(`Cannot assign attributes: user not found for ${invitation.usernameOrEmail}`);
        return { success: false };
      }

      const validatedAttributes = (invitation.attributes ?? [])
        .filter((attr) => validAttributeMap.has(attr.id))
        .map((attr) => ({
          ...attr,
          type: validAttributeMap.get(attr.id),
        }));

      if (validatedAttributes.length === 0) {
        return { success: true };
      }

      try {
        const result = await prisma.$transaction(async (tx) => {
          return processUserAttributes(tx, userId, teamId, validatedAttributes);
        });
        return result;
      } catch (error) {
        myLog.warn(`Failed to assign attributes for user ${invitation.usernameOrEmail}`, error);
        return { success: false };
      }
    })
  );

  const assignedUserEmails: string[] = [];
  let numFailed = 0;

  for (let i = 0; i < results.length; i++) {
    if (results[i].success) {
      assignedUserEmails.push(invitationsWithAttributes[i].usernameOrEmail);
    } else {
      numFailed++;
    }
  }

  return { assignedUserEmails, numFailed };
}

export async function handleRoleAndAttributeUpdates({
  existingMembersToUpdate,
  invitations,
  teamId,
  isOrg,
}: {
  existingMembersToUpdate: Array<{
    id: number;
    email: string;
    username: string | null;
    newRole: MembershipRole;
  }>;
  invitations: ImportInvitation[];
  teamId: number;
  isOrg: boolean;
}): Promise<{ numUsersUpdated: number; numUpdatesFailed: number }> {
  const updatedUserIds = new Set<number>();
  let numUpdatesFailed = 0;

  if (existingMembersToUpdate.length > 0) {
    const roleUpdatedIds = await handleExistingMemberRoleUpdates({
      existingMembersToUpdate,
      teamId,
    });
    for (const id of roleUpdatedIds) updatedUserIds.add(id);
  }

  if (isOrg) {
    const existingEmailToId = new Map(existingMembersToUpdate.map((m) => [m.email, m.id]));
    const { assignedUserEmails, numFailed } = await handleAttributeAssignment({
      invitations,
      teamId,
    });
    for (const email of assignedUserEmails) {
      const userId = existingEmailToId.get(email);
      if (userId) updatedUserIds.add(userId);
    }
    numUpdatesFailed = numFailed;
  }

  return { numUsersUpdated: updatedUserIds.size, numUpdatesFailed };
}
