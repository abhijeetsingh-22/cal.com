import { MembershipRole } from "@calcom/prisma/enums";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INVITE_STATUS } from "../inviteMember/utils";

const {
  mockMembershipFindMany,
  mockMembershipUpdateMany,
  mockAttributeFindMany,
  mockUserFindMany,
  mockProcessUserAttributes,
  mockTransaction,
  mockCanInviteToTeam,
  mockIsOrganisationOwner,
  mockGetTranslation,
} = vi.hoisted(() => {
  const mockMembershipFindManyFn = vi.fn();
  const mockMembershipUpdateManyFn = vi.fn();
  const mockAttributeFindManyFn = vi.fn();
  const mockUserFindManyFn = vi.fn();
  const mockProcessUserAttributesFn = vi.fn();
  const mockTransactionFn = vi.fn(async (callbackOrArray: any) => {
    if (Array.isArray(callbackOrArray)) {
      return Promise.all(callbackOrArray);
    }
    return callbackOrArray({});
  });
  const mockCanInviteToTeamFn = vi.fn().mockResolvedValue({ allowed: true });
  const mockIsOrganisationOwnerFn = vi.fn().mockResolvedValue(true);
  const mockGetTranslationFn = vi.fn().mockResolvedValue((key: string) => key);

  return {
    mockMembershipFindMany: mockMembershipFindManyFn,
    mockMembershipUpdateMany: mockMembershipUpdateManyFn,
    mockAttributeFindMany: mockAttributeFindManyFn,
    mockUserFindMany: mockUserFindManyFn,
    mockProcessUserAttributes: mockProcessUserAttributesFn,
    mockTransaction: mockTransactionFn,
    mockCanInviteToTeam: mockCanInviteToTeamFn,
    mockIsOrganisationOwner: mockIsOrganisationOwnerFn,
    mockGetTranslation: mockGetTranslationFn,
  };
});

vi.mock("@calcom/prisma", () => {
  return {
    prisma: {
      membership: {
        findMany: mockMembershipFindMany,
        updateMany: mockMembershipUpdateMany,
      },
      user: {
        findMany: mockUserFindMany,
      },
      attribute: {
        findMany: mockAttributeFindMany,
      },
      $transaction: mockTransaction,
    },
  };
});

vi.mock("../../attributes/attributeUtils", () => ({
  processUserAttributes: (...args: unknown[]) => mockProcessUserAttributes(...args),
}));

vi.mock("@calcom/lib/logger", () => {
  const mockSubLogger = {
    debug: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    getSubLogger: vi.fn(() => mockSubLogger),
  };
  return {
    default: {
      getSubLogger: vi.fn(() => mockSubLogger),
      error: vi.fn(),
      debug: vi.fn(),
      log: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
    },
  };
});

vi.mock("@calcom/features/ee/billing/service/dueInvoice/DueInvoiceService", () => ({
  DueInvoiceService: vi.fn().mockImplementation(function () {
    return {
      canInviteToTeam: mockCanInviteToTeam,
    };
  }),
}));

vi.mock("@calcom/features/pbac/utils/isOrganisationAdmin", () => ({
  isOrganisationOwner: (...args: unknown[]) => mockIsOrganisationOwner(...args),
}));

vi.mock("@calcom/lib/server/i18n", () => ({
  getTranslation: (...args: unknown[]) => mockGetTranslation(...args),
}));

vi.mock("@trpc/server", () => {
  return {
    TRPCError: class TRPCError {
      code: string;
      message: unknown;
      constructor({ code, message }: { code: string; message?: unknown }) {
        this.code = code;
        this.message = message;
      }
    },
  };
});

import {
  ensureBillingAllowsImport,
  ensureCanGrantOwnerRole,
  handleAttributeAssignment,
  handleExistingMemberRoleUpdates,
  handleRoleAndAttributeUpdates,
} from "./utils";

describe("importMembers utils", () => {
  describe("handleExistingMemberRoleUpdates", () => {
    beforeEach(() => {
      mockMembershipFindMany.mockReset();
      mockMembershipUpdateMany.mockReset();
      mockTransaction.mockClear();
    });

    it("should return IDs of members whose role actually changed", async () => {
      mockMembershipFindMany.mockResolvedValueOnce([
        { userId: 1, role: MembershipRole.MEMBER },
        { userId: 2, role: MembershipRole.ADMIN },
      ]);
      mockMembershipUpdateMany.mockResolvedValue({ count: 1 });

      const result = await handleExistingMemberRoleUpdates({
        existingMembersToUpdate: [
          { id: 1, email: "user1@example.com", username: "user1", newRole: MembershipRole.ADMIN },
          { id: 2, email: "user2@example.com", username: "user2", newRole: MembershipRole.ADMIN },
        ],
        teamId: 100,
      });

      expect(result).toEqual([1]);
      expect(mockMembershipUpdateMany).toHaveBeenCalledWith({
        where: { userId: { in: [1] }, teamId: 100 },
        data: { role: MembershipRole.ADMIN },
      });
    });

    it("should return empty array when existing role matches new role", async () => {
      mockMembershipFindMany.mockResolvedValueOnce([{ userId: 1, role: MembershipRole.MEMBER }]);

      const result = await handleExistingMemberRoleUpdates({
        existingMembersToUpdate: [
          { id: 1, email: "user1@example.com", username: "user1", newRole: MembershipRole.MEMBER },
        ],
        teamId: 100,
      });

      expect(result).toEqual([]);
      expect(mockMembershipUpdateMany).not.toHaveBeenCalled();
    });
  });

  describe("handleAttributeAssignment", () => {
    beforeEach(() => {
      mockAttributeFindMany.mockReset();
      mockUserFindMany.mockReset();
      mockProcessUserAttributes.mockReset();
      mockTransaction.mockClear();
    });

    it("should return empty arrays when no invitations have attributes", async () => {
      const result = await handleAttributeAssignment({
        invitations: [{ usernameOrEmail: "user@example.com", role: MembershipRole.MEMBER }],
        teamId: 1,
      });

      expect(result).toEqual({ assignedUserEmails: [], numFailed: 0 });
    });

    it("should return assigned emails on success", async () => {
      mockAttributeFindMany.mockResolvedValueOnce([{ id: "attr-1", type: "TEXT" }]);
      mockUserFindMany.mockResolvedValueOnce([{ id: 10, email: "user@example.com" }]);
      mockProcessUserAttributes.mockResolvedValueOnce({ success: true });

      const result = await handleAttributeAssignment({
        invitations: [
          {
            usernameOrEmail: "user@example.com",
            role: MembershipRole.MEMBER,
            attributes: [{ id: "attr-1", value: "Engineering" }],
          },
        ],
        teamId: 1,
      });

      expect(result).toEqual({ assignedUserEmails: ["user@example.com"], numFailed: 0 });
    });

    it("should count failure when processUserAttributes throws", async () => {
      mockAttributeFindMany.mockResolvedValueOnce([{ id: "attr-1", type: "TEXT" }]);
      mockUserFindMany.mockResolvedValueOnce([{ id: 10, email: "user@example.com" }]);
      mockTransaction.mockRejectedValueOnce(new Error("DB error"));

      const result = await handleAttributeAssignment({
        invitations: [
          {
            usernameOrEmail: "user@example.com",
            role: MembershipRole.MEMBER,
            attributes: [{ id: "attr-1", value: "Engineering" }],
          },
        ],
        teamId: 1,
      });

      expect(result).toEqual({ assignedUserEmails: [], numFailed: 1 });
    });

    it("should filter out attributes that are not valid for the team", async () => {
      mockAttributeFindMany.mockResolvedValueOnce([{ id: "attr-1", type: "TEXT" }]);
      mockUserFindMany.mockResolvedValueOnce([{ id: 10, email: "user@example.com" }]);
      mockProcessUserAttributes.mockResolvedValueOnce({ success: true });

      const result = await handleAttributeAssignment({
        invitations: [
          {
            usernameOrEmail: "user@example.com",
            role: MembershipRole.MEMBER,
            attributes: [
              { id: "attr-1", value: "Engineering" },
              { id: "attr-invalid", value: "Should be filtered" },
            ],
          },
        ],
        teamId: 1,
      });

      expect(result).toEqual({ assignedUserEmails: ["user@example.com"], numFailed: 0 });
      expect(mockProcessUserAttributes).toHaveBeenCalledWith(expect.anything(), 10, 1, [
        expect.objectContaining({ id: "attr-1" }),
      ]);
    });
  });

  describe("handleRoleAndAttributeUpdates", () => {
    beforeEach(() => {
      mockMembershipFindMany.mockReset();
      mockMembershipUpdateMany.mockReset();
      mockAttributeFindMany.mockReset();
      mockUserFindMany.mockReset();
      mockProcessUserAttributes.mockReset();
      mockTransaction.mockClear();
    });

    it("should count role-updated user", async () => {
      mockMembershipFindMany.mockResolvedValueOnce([{ userId: 1, role: MembershipRole.MEMBER }]);
      mockMembershipUpdateMany.mockResolvedValue({ count: 1 });

      const result = await handleRoleAndAttributeUpdates({
        existingMembersToUpdate: [
          { id: 1, email: "user1@example.com", username: "user1", newRole: MembershipRole.ADMIN },
        ],
        invitations: [{ usernameOrEmail: "user1@example.com", role: MembershipRole.ADMIN }],
        teamId: 1,
        isOrg: false,
      });

      expect(result).toEqual({ numUsersUpdated: 1, numUpdatesFailed: 0 });
    });

    it("should deduplicate user who has both role change and attribute assignment", async () => {
      mockMembershipFindMany.mockResolvedValueOnce([{ userId: 1, role: MembershipRole.MEMBER }]);
      mockMembershipUpdateMany.mockResolvedValue({ count: 1 });
      mockAttributeFindMany.mockResolvedValueOnce([{ id: "attr-1", type: "TEXT" }]);
      mockUserFindMany.mockResolvedValueOnce([{ id: 1, email: "user1@example.com" }]);
      mockProcessUserAttributes.mockResolvedValueOnce({ success: true });

      const result = await handleRoleAndAttributeUpdates({
        existingMembersToUpdate: [
          { id: 1, email: "user1@example.com", username: "user1", newRole: MembershipRole.ADMIN },
        ],
        invitations: [
          {
            usernameOrEmail: "user1@example.com",
            role: MembershipRole.ADMIN,
            attributes: [{ id: "attr-1", value: "Engineering" }],
          },
        ],
        teamId: 1,
        isOrg: true,
      });

      expect(result).toEqual({ numUsersUpdated: 1, numUpdatesFailed: 0 });
    });

    it("should not process attributes for non-org teams", async () => {
      mockMembershipFindMany.mockResolvedValueOnce([{ userId: 1, role: MembershipRole.MEMBER }]);
      mockMembershipUpdateMany.mockResolvedValue({ count: 1 });

      const result = await handleRoleAndAttributeUpdates({
        existingMembersToUpdate: [
          { id: 1, email: "user1@example.com", username: "user1", newRole: MembershipRole.ADMIN },
        ],
        invitations: [
          {
            usernameOrEmail: "user1@example.com",
            role: MembershipRole.ADMIN,
            attributes: [{ id: "attr-1", value: "Engineering" }],
          },
        ],
        teamId: 1,
        isOrg: false,
      });

      expect(result).toEqual({ numUsersUpdated: 1, numUpdatesFailed: 0 });
      expect(mockAttributeFindMany).not.toHaveBeenCalled();
    });

    it("should count attribute failures", async () => {
      mockMembershipFindMany.mockResolvedValueOnce([{ userId: 1, role: MembershipRole.MEMBER }]);
      mockAttributeFindMany.mockResolvedValueOnce([{ id: "attr-1", type: "TEXT" }]);
      mockUserFindMany.mockResolvedValueOnce([{ id: 1, email: "user1@example.com" }]);
      mockTransaction.mockRejectedValueOnce(new Error("DB error"));

      const result = await handleRoleAndAttributeUpdates({
        existingMembersToUpdate: [
          { id: 1, email: "user1@example.com", username: "user1", newRole: MembershipRole.MEMBER },
        ],
        invitations: [
          {
            usernameOrEmail: "user1@example.com",
            role: MembershipRole.MEMBER,
            attributes: [{ id: "attr-1", value: "Engineering" }],
          },
        ],
        teamId: 1,
        isOrg: true,
      });

      expect(result.numUpdatesFailed).toBe(1);
    });
  });

  describe("ensureBillingAllowsImport", () => {
    beforeEach(() => {
      mockCanInviteToTeam.mockReset().mockResolvedValue({ allowed: true });
      mockGetTranslation.mockReset().mockResolvedValue((key: string) => key);
    });

    it("should skip billing check when no new seats will be added (only attribute / role updates)", async () => {
      await ensureBillingAllowsImport({
        existingUsers: [
          { canBeInvited: INVITE_STATUS.USER_ALREADY_INVITED_OR_MEMBER },
          { canBeInvited: INVITE_STATUS.USER_ALREADY_INVITED_OR_MEMBER },
        ],
        uniqueInvitations: [
          { usernameOrEmail: "a@example.com", role: MembershipRole.MEMBER },
          { usernameOrEmail: "b@example.com", role: MembershipRole.MEMBER },
        ],
        team: { id: 1, parentId: null },
        language: "en",
      });

      expect(mockCanInviteToTeam).not.toHaveBeenCalled();
    });

    it("should throw FORBIDDEN when billing blocks invitation", async () => {
      mockCanInviteToTeam.mockResolvedValueOnce({
        allowed: false,
        reason: "invitations_blocked_unpaid_invoice",
      });

      await expect(
        ensureBillingAllowsImport({
          existingUsers: [],
          uniqueInvitations: [{ usernameOrEmail: "new@example.com", role: MembershipRole.MEMBER }],
          team: { id: 1, parentId: null },
          language: "en",
        })
      ).rejects.toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
    });

    it("should pass when billing allows invitation", async () => {
      mockCanInviteToTeam.mockResolvedValueOnce({ allowed: true });

      await expect(
        ensureBillingAllowsImport({
          existingUsers: [],
          uniqueInvitations: [{ usernameOrEmail: "new@example.com", role: MembershipRole.MEMBER }],
          team: { id: 1, parentId: null },
          language: "en",
        })
      ).resolves.toBeUndefined();
    });

    it("should check billing when an existing user CAN_BE_INVITED (new seat)", async () => {
      mockCanInviteToTeam.mockResolvedValueOnce({ allowed: true });

      await ensureBillingAllowsImport({
        existingUsers: [{ canBeInvited: INVITE_STATUS.CAN_BE_INVITED }],
        uniqueInvitations: [{ usernameOrEmail: "user@example.com", role: MembershipRole.MEMBER }],
        team: { id: 1, parentId: null },
        language: "en",
      });

      expect(mockCanInviteToTeam).toHaveBeenCalled();
    });
  });

  describe("ensureCanGrantOwnerRole", () => {
    beforeEach(() => {
      mockIsOrganisationOwner.mockReset().mockResolvedValue(true);
    });

    it("should skip when team is not an org", async () => {
      await ensureCanGrantOwnerRole({
        existingUsers: [],
        uniqueInvitations: [{ usernameOrEmail: "new@example.com", role: MembershipRole.OWNER }],
        teamId: 1,
        isTeamAnOrg: false,
        inviterId: 123,
      });

      expect(mockIsOrganisationOwner).not.toHaveBeenCalled();
    });

    it("should skip when no OWNER role is being granted", async () => {
      await ensureCanGrantOwnerRole({
        existingUsers: [],
        uniqueInvitations: [{ usernameOrEmail: "new@example.com", role: MembershipRole.MEMBER }],
        teamId: 1,
        isTeamAnOrg: true,
        inviterId: 123,
      });

      expect(mockIsOrganisationOwner).not.toHaveBeenCalled();
    });

    it("should throw UNAUTHORIZED when inviter is not org owner", async () => {
      mockIsOrganisationOwner.mockResolvedValueOnce(false);

      await expect(
        ensureCanGrantOwnerRole({
          existingUsers: [],
          uniqueInvitations: [{ usernameOrEmail: "new@example.com", role: MembershipRole.OWNER }],
          teamId: 1,
          isTeamAnOrg: true,
          inviterId: 123,
        })
      ).rejects.toThrow(expect.objectContaining({ code: "UNAUTHORIZED" }));
    });

    it("should pass when inviter is org owner", async () => {
      mockIsOrganisationOwner.mockResolvedValueOnce(true);

      await expect(
        ensureCanGrantOwnerRole({
          existingUsers: [],
          uniqueInvitations: [{ usernameOrEmail: "new@example.com", role: MembershipRole.OWNER }],
          teamId: 1,
          isTeamAnOrg: true,
          inviterId: 123,
        })
      ).resolves.toBeUndefined();
    });

    it("should throw when existing MEMBER is upgraded to OWNER by non-owner inviter", async () => {
      mockIsOrganisationOwner.mockResolvedValueOnce(false);

      await expect(
        ensureCanGrantOwnerRole({
          existingUsers: [
            {
              email: "member@example.com",
              canBeInvited: INVITE_STATUS.USER_ALREADY_INVITED_OR_MEMBER,
              teams: [{ teamId: 1, role: MembershipRole.MEMBER }],
            },
          ],
          uniqueInvitations: [{ usernameOrEmail: "member@example.com", role: MembershipRole.OWNER }],
          teamId: 1,
          isTeamAnOrg: true,
          inviterId: 123,
        })
      ).rejects.toThrow(expect.objectContaining({ code: "UNAUTHORIZED" }));
    });

    it("should skip when re-importing existing OWNER as OWNER (no-op)", async () => {
      await ensureCanGrantOwnerRole({
        existingUsers: [
          {
            email: "owner@example.com",
            canBeInvited: INVITE_STATUS.USER_ALREADY_INVITED_OR_MEMBER,
            teams: [{ teamId: 1, role: MembershipRole.OWNER }],
          },
        ],
        uniqueInvitations: [{ usernameOrEmail: "owner@example.com", role: MembershipRole.OWNER }],
        teamId: 1,
        isTeamAnOrg: true,
        inviterId: 123,
      });

      expect(mockIsOrganisationOwner).not.toHaveBeenCalled();
    });
  });
});
