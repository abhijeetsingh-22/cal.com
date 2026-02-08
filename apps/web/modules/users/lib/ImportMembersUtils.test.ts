import { MembershipRole } from "@calcom/prisma/enums";
import { describe, expect, it } from "vitest";
import type { AttributeDefinition } from "./ImportMembersUtils";
import { parseCSVContent } from "./ImportMembersUtils";

const t = (key: string) => key;

function createAttribute(
  overrides: Pick<AttributeDefinition, "id" | "name" | "type" | "isWeightsEnabled"> & {
    options?: Array<Pick<AttributeDefinition["options"][number], "id" | "value">>;
  }
): AttributeDefinition {
  return {
    teamId: 1,
    slug: overrides.name.toLowerCase().replace(/\s+/g, "-"),
    enabled: true,
    usersCanEditRelation: false,
    isLocked: false,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    ...overrides,
    options: (overrides.options ?? []).map((opt) => ({
      attributeId: overrides.id,
      slug: opt.value.toLowerCase().replace(/\s+/g, "-"),
      isGroup: false,
      contains: [],
      assignedUsers: [],
      ...opt,
    })),
  };
}

describe("parseCSVContent", () => {
  it("should parse basic CSV with email and role", () => {
    const csv = "Members,Role\njohn@example.com,ADMIN\njane@example.com,MEMBER";
    const result = parseCSVContent({
      csvText: csv,
      defaultRole: MembershipRole.MEMBER,
      t,
    });

    expect(result).toEqual([
      { email: "john@example.com", role: MembershipRole.ADMIN },
      { email: "jane@example.com", role: MembershipRole.MEMBER },
    ]);
  });

  it("should use default role when no role column exists", () => {
    const csv = "Members\njohn@example.com\njane@example.com";
    const result = parseCSVContent({
      csvText: csv,
      defaultRole: MembershipRole.ADMIN,
      t,
    });

    expect(result).toEqual([
      { email: "john@example.com", role: MembershipRole.ADMIN },
      { email: "jane@example.com", role: MembershipRole.ADMIN },
    ]);
  });

  it("should throw when Members column is missing", () => {
    const csv = "Email,Role\njohn@example.com,ADMIN";
    expect(() =>
      parseCSVContent({
        csvText: csv,
        defaultRole: MembershipRole.MEMBER,
        t,
      })
    ).toThrow("csv_file_must_have_members_column");
  });

  it("should throw when no valid emails are found", () => {
    const csv = "Members\nnot-an-email\nalso-not-email";
    expect(() =>
      parseCSVContent({
        csvText: csv,
        defaultRole: MembershipRole.MEMBER,
        t,
      })
    ).toThrow("no_valid_email_addresses_found");
  });

  it("should parse TEXT attribute values", () => {
    const textAttr = createAttribute({
      id: "attr-text",
      name: "Department",
      type: "TEXT",
      isWeightsEnabled: false,
    });
    const csv = "Members,Department\njohn@example.com,Engineering";
    const result = parseCSVContent({
      csvText: csv,
      enabledAttributes: [textAttr],
      defaultRole: MembershipRole.MEMBER,
      t,
    });

    expect(result[0].attributes).toEqual([{ id: "attr-text", value: "Engineering" }]);
  });

  it("should parse SINGLE_SELECT with weighted option", () => {
    const singleSelectAttr = createAttribute({
      id: "attr-single",
      name: "Level",
      type: "SINGLE_SELECT",
      isWeightsEnabled: true,
      options: [
        { id: "opt-junior", value: "Junior" },
        { id: "opt-senior", value: "Senior" },
      ],
    });
    const csv = "Members,Level\njohn@example.com,Junior (80%)";
    const result = parseCSVContent({
      csvText: csv,
      enabledAttributes: [singleSelectAttr],
      defaultRole: MembershipRole.MEMBER,
      t,
    });

    expect(result[0].attributes).toEqual([
      { id: "attr-single", options: [{ value: "opt-junior", weight: 80 }] },
    ]);
  });

  it("should parse MULTI_SELECT comma-separated values", () => {
    const multiSelectAttr = createAttribute({
      id: "attr-multi",
      name: "Skills",
      type: "MULTI_SELECT",
      isWeightsEnabled: false,
      options: [
        { id: "opt-js", value: "JavaScript" },
        { id: "opt-ts", value: "TypeScript" },
        { id: "opt-py", value: "Python" },
      ],
    });
    const csv = 'Members,Skills\njohn@example.com,"JavaScript,TypeScript"';
    const result = parseCSVContent({
      csvText: csv,
      enabledAttributes: [multiSelectAttr],
      defaultRole: MembershipRole.MEMBER,
      t,
    });

    expect(result[0].attributes).toEqual([
      {
        id: "attr-multi",
        options: [{ value: "opt-js" }, { value: "opt-ts" }],
      },
    ]);
  });

  it("should parse multiple attribute columns together", () => {
    const attributes = [
      createAttribute({
        id: "attr-dept",
        name: "Department",
        type: "TEXT",
        isWeightsEnabled: false,
      }),
      createAttribute({
        id: "attr-level",
        name: "Level",
        type: "SINGLE_SELECT",
        isWeightsEnabled: false,
        options: [
          { id: "opt-junior", value: "Junior" },
          { id: "opt-senior", value: "Senior" },
        ],
      }),
    ];
    const csv = "Members,Role,Department,Level\njohn@example.com,ADMIN,Engineering,Senior";
    const result = parseCSVContent({
      csvText: csv,
      enabledAttributes: attributes,
      defaultRole: MembershipRole.MEMBER,
      t,
    });

    expect(result[0]).toEqual({
      email: "john@example.com",
      role: MembershipRole.ADMIN,
      attributes: [
        { id: "attr-dept", value: "Engineering" },
        { id: "attr-level", options: [{ value: "opt-senior" }] },
      ],
    });
  });

  it("should handle rows with partial attribute data", () => {
    const attributes = [
      createAttribute({
        id: "attr-dept",
        name: "Department",
        type: "TEXT",
        isWeightsEnabled: false,
      }),
      createAttribute({
        id: "attr-level",
        name: "Level",
        type: "SINGLE_SELECT",
        isWeightsEnabled: false,
        options: [
          { id: "opt-junior", value: "Junior" },
          { id: "opt-senior", value: "Senior" },
        ],
      }),
    ];
    const csv = "Members,Department,Level\njohn@example.com,Engineering,\njane@example.com,,Senior";
    const result = parseCSVContent({
      csvText: csv,
      enabledAttributes: attributes,
      defaultRole: MembershipRole.MEMBER,
      t,
    });

    expect(result[0].attributes).toEqual([{ id: "attr-dept", value: "Engineering" }]);
    expect(result[1].attributes).toEqual([{ id: "attr-level", options: [{ value: "opt-senior" }] }]);
  });
});
