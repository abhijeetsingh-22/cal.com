import { CreationSource, MembershipRole } from "@calcom/prisma/enums";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcSessionUser } from "../../../../types";
import { INVITE_STATUS } from "../inviteMember/types";

vi.mock("@trpc/server", () => {
  return {
    TRPCError: class TRPCError {
      code: string;
      message: unknown;
      constructor({ code, message }: { code: string; message: unknown }) {
        this.code = code;
        this.message = message;
      }
    },
  };
});

const mockCheckRateLimitAndThrowError = vi.fn();
vi.mock("@calcom/lib/checkRateLimitAndThrowError", () => ({
  checkRateLimitAndThrowError: (...args: unknown[]) => mockCheckRateLimitAndThrowError(...args),
}));

const mockCheckPermission = vi.fn().mockResolvedValue(true);
vi.mock("@calcom/features/pbac/services/permission-check.service", () => ({
  PermissionCheckService: vi.fn().mockImplementation(function () {
    return {
      checkPermission: mockCheckPermission,
    };
  }),
}));

const mockGetTeamOrThrow = vi.fn();
const mockEnsureAtleastAdminPermissions = vi.fn().mockResolvedValue(undefined);
const mockFindUsersWithInviteStatus = vi.fn();
const mockGetUniqueInvitationsOrThrowIfEmpty = vi.fn();

vi.mock("../inviteMember/utils", () => ({
  getTeamOrThrow: (...args: unknown[]) => mockGetTeamOrThrow(...args),
  ensureAtleastAdminPermissions: (...args: unknown[]) => mockEnsureAtleastAdminPermissions(...args),
  findUsersWithInviteStatus: (...args: unknown[]) => mockFindUsersWithInviteStatus(...args),
  getUniqueInvitationsOrThrowIfEmpty: (...args: unknown[]) => mockGetUniqueInvitationsOrThrowIfEmpty(...args),
  INVITE_STATUS: {
    USER_PENDING_MEMBER_OF_THE_ORG: "USER_PENDING_MEMBER_OF_THE_ORG",
    USER_ALREADY_INVITED_OR_MEMBER: "USER_ALREADY_INVITED_OR_MEMBER",
    USER_MEMBER_OF_OTHER_ORGANIZATION: "USER_MEMBER_OF_OTHER_ORGANIZATION",
    CAN_BE_INVITED: "CAN_BE_INVITED",
  },
}));

const mockInviteMembersWithNoInviterPermissionCheck = vi.fn();
vi.mock("../inviteMember/inviteMember.handler", () => ({
  inviteMembersWithNoInviterPermissionCheck: (...args: unknown[]) =>
    mockInviteMembersWithNoInviterPermissionCheck(...args),
}));

const mockHandleRoleAndAttributeUpdates = vi.fn();
const mockEnsureBillingAllowsImport = vi.fn().mockResolvedValue(undefined);
const mockEnsureCanGrantOwnerRole = vi.fn().mockResolvedValue(undefined);
vi.mock("./utils", () => ({
  handleRoleAndAttributeUpdates: (...args: unknown[]) => mockHandleRoleAndAttributeUpdates(...args),
  ensureBillingAllowsImport: (...args: unknown[]) => mockEnsureBillingAllowsImport(...args),
  ensureCanGrantOwnerRole: (...args: unknown[]) => mockEnsureCanGrantOwnerRole(...args),
}));

vi.mock("@calcom/prisma", () => ({
  prisma: {},
}));

function getLoggedInUser() {
  return {
    id: 123,
    name: "John Doe",
    organization: {
      id: 456,
      isOrgAdmin: true,
      metadata: null,
      requestedSlug: null,
    },
    profile: {
      id: null,
      upId: "abc",
      organization: null,
      organizationId: null,
      username: "john_doe",
      startTime: 0,
      endTime: 0,
      avatarUrl: "",
      name: "",
      bufferTime: 0,
    },
  } as NonNullable<TrpcSessionUser>;
}

function getTeam(overrides: Record<string, unknown> = {}) {
  return {
    id: 456,
    name: "Test Org",
    isOrganization: true,
    parentId: null,
    parent: null,
    organizationSettings: null,
    metadata: {},
    ...overrides,
  };
}

describe("importMembersHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimitAndThrowError.mockResolvedValue(undefined);
    mockGetTeamOrThrow.mockResolvedValue(getTeam());
    mockGetUniqueInvitationsOrThrowIfEmpty.mockImplementation((invitations) => Promise.resolve(invitations));
    mockFindUsersWithInviteStatus.mockResolvedValue([]);
    mockInviteMembersWithNoInviterPermissionCheck.mockResolvedValue({ numUsersInvited: 0 });
    mockHandleRoleAndAttributeUpdates.mockResolvedValue({ numUsersUpdated: 0, numUpdatesFailed: 0 });
    mockEnsureBillingAllowsImport.mockResolvedValue(undefined);
    mockEnsureCanGrantOwnerRole.mockResolvedValue(undefined);
  });

  const baseInput = {
    teamId: 456,
    members: [{ email: "new@example.com", role: MembershipRole.MEMBER }],
    language: "en",
    creationSource: CreationSource.WEBAPP,
  };

  it("should handle all new users", async () => {
    mockInviteMembersWithNoInviterPermissionCheck.mockResolvedValueOnce({ numUsersInvited: 2 });

    const handler = (await import("./importMembers.handler")).default;
    const result = await handler({
      ctx: { user: getLoggedInUser() },
      input: {
        ...baseInput,
        members: [
          { email: "new1@example.com", role: MembershipRole.MEMBER },
          { email: "new2@example.com", role: MembershipRole.MEMBER },
        ],
      },
    });

    expect(result).toEqual({
      numUsersInvited: 2,
      numUsersUpdated: 0,
      numUpdatesFailed: 0,
    });
  });

  it("should handle mix of new and existing members", async () => {
    mockFindUsersWithInviteStatus.mockResolvedValueOnce([
      {
        id: 1,
        email: "existing@example.com",
        username: "existing",
        canBeInvited: INVITE_STATUS.USER_ALREADY_INVITED_OR_MEMBER,
        newRole: MembershipRole.ADMIN,
      },
    ]);
    mockInviteMembersWithNoInviterPermissionCheck.mockResolvedValueOnce({ numUsersInvited: 1 });
    mockHandleRoleAndAttributeUpdates.mockResolvedValueOnce({ numUsersUpdated: 1, numUpdatesFailed: 0 });

    const handler = (await import("./importMembers.handler")).default;
    const result = await handler({
      ctx: { user: getLoggedInUser() },
      input: {
        ...baseInput,
        members: [
          { email: "existing@example.com", role: MembershipRole.ADMIN },
          { email: "new@example.com", role: MembershipRole.MEMBER },
        ],
      },
    });

    expect(result).toEqual({
      numUsersInvited: 1,
      numUsersUpdated: 1,
      numUpdatesFailed: 0,
    });
  });

  it("should report update failures", async () => {
    mockFindUsersWithInviteStatus.mockResolvedValueOnce([
      {
        id: 1,
        email: "existing@example.com",
        username: "existing",
        canBeInvited: INVITE_STATUS.USER_ALREADY_INVITED_OR_MEMBER,
        newRole: MembershipRole.ADMIN,
      },
    ]);
    mockInviteMembersWithNoInviterPermissionCheck.mockResolvedValueOnce({ numUsersInvited: 0 });
    mockHandleRoleAndAttributeUpdates.mockResolvedValueOnce({ numUsersUpdated: 0, numUpdatesFailed: 1 });

    const handler = (await import("./importMembers.handler")).default;
    const result = await handler({
      ctx: { user: getLoggedInUser() },
      input: {
        ...baseInput,
        members: [{ email: "existing@example.com", role: MembershipRole.ADMIN }],
      },
    });

    expect(result).toEqual({
      numUsersInvited: 0,
      numUsersUpdated: 0,
      numUpdatesFailed: 1,
    });
  });

  it("should throw FORBIDDEN when permission check fails", async () => {
    mockCheckPermission.mockResolvedValueOnce(false);

    const handler = (await import("./importMembers.handler")).default;
    await expect(
      handler({
        ctx: { user: getLoggedInUser() },
        input: baseInput,
      })
    ).rejects.toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("should throw when rate limit exceeded", async () => {
    mockCheckRateLimitAndThrowError.mockRejectedValueOnce(new Error("Rate limit exceeded"));

    const handler = (await import("./importMembers.handler")).default;
    await expect(
      handler({
        ctx: { user: getLoggedInUser() },
        input: baseInput,
      })
    ).rejects.toThrow("Rate limit exceeded");
  });

  it("should propagate billing guard error", async () => {
    const billingError = { code: "FORBIDDEN", message: "invitations_blocked_unpaid_invoice" };
    mockEnsureBillingAllowsImport.mockRejectedValueOnce(billingError);

    const handler = (await import("./importMembers.handler")).default;
    await expect(
      handler({
        ctx: { user: getLoggedInUser() },
        input: baseInput,
      })
    ).rejects.toEqual(billingError);
  });

  it("should propagate owner guard error", async () => {
    const ownerError = { code: "UNAUTHORIZED" };
    mockEnsureCanGrantOwnerRole.mockRejectedValueOnce(ownerError);

    const handler = (await import("./importMembers.handler")).default;
    await expect(
      handler({
        ctx: { user: getLoggedInUser() },
        input: baseInput,
      })
    ).rejects.toEqual(ownerError);
  });
});
