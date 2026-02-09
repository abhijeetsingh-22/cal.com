import { emailRegex } from "@calcom/lib/emailSchema";
import type { MembershipRole } from "@calcom/prisma/enums";
import { MembershipRole as MembershipRoleEnum } from "@calcom/prisma/enums";
import type { RouterOutputs } from "@calcom/trpc/react";
import { showToast } from "@calcom/ui/components/toast";

function parseCSVRow(row: string): string[] {
  const result: string[] = [];
  let insideQuotes = false;
  let currentValue = "";

  for (let i = 0; i < row.length; i++) {
    const char = row[i];
    if (char === '"') {
      insideQuotes = !insideQuotes;
    } else if (char === "," && !insideQuotes) {
      result.push(currentValue.trim());
      currentValue = "";
    } else {
      currentValue += char;
    }
  }
  result.push(currentValue.trim());

  return result.map((val) => {
    if (val.startsWith('"') && val.endsWith('"')) {
      return val.substring(1, val.length - 1).replace(/""/g, '"');
    }
    return val;
  });
}
export type AttributeDefinition = RouterOutputs["viewer"]["attributes"]["list"][number];
export interface UserInvitation {
  email: string;
  role: MembershipRole;
  attributes?: Array<{
    id: string;
    value?: string;
    options?: Array<{ value: string; weight?: number }>;
  }>;
}

export function stripBOM(text: string): string {
  // biome-ignore lint/nursery/noTernary : simple BOM check
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
export function parseCSVContent({
  csvText,
  enabledAttributes,
  defaultRole,
  t,
}: {
  csvText: string;
  enabledAttributes?: AttributeDefinition[];
  defaultRole: MembershipRole;
  t: (key: string) => string;
}): UserInvitation[] {
  const lines = csvText.split("\n");
  const headers = parseCSVRow(lines[0]);
  const emailIndex = headers.findIndex((h) => h.toLowerCase() === "members");
  const roleIndex = headers.findIndex((h) => h.toLowerCase() === "role");

  if (emailIndex === -1) {
    throw new Error(t("csv_file_must_have_members_column"));
  }

  const attributeColumns: Array<{
    columnIndex: number;
    attribute: AttributeDefinition;
  }> = [];

  if (enabledAttributes) {
    headers.forEach((header, colIndex) => {
      if (colIndex === emailIndex || colIndex === roleIndex) return;
      const matchedAttr = enabledAttributes.find((attr) => attr.name.toLowerCase() === header.toLowerCase());
      if (matchedAttr) {
        attributeColumns.push({ columnIndex: colIndex, attribute: matchedAttr });
      }
    });
  }

  const users: UserInvitation[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const columns = parseCSVRow(line);
    const email = columns[emailIndex]?.trim();

    if (!email || !emailRegex.test(email)) {
      continue;
    }

    let role = defaultRole;
    if (roleIndex !== -1 && columns[roleIndex]) {
      const roleValue = columns[roleIndex].trim().toUpperCase();
      if (Object.values(MembershipRoleEnum).includes(roleValue as MembershipRole)) {
        role = roleValue as MembershipRole;
      }
    }

    const parsedAttributes: UserInvitation["attributes"] = [];

    for (const { columnIndex, attribute } of attributeColumns) {
      const cellValue = columns[columnIndex]?.trim();
      if (!cellValue) continue;

      if (attribute.type === "TEXT" || attribute.type === "NUMBER") {
        const cleanValue = cellValue.endsWith(" (100%)") ? cellValue.slice(0, -7) : cellValue;
        parsedAttributes.push({
          id: attribute.id,
          value: cleanValue,
        });
      } else if (attribute.type === "SINGLE_SELECT" || attribute.type === "MULTI_SELECT") {
        const rawValues =
          attribute.type === "MULTI_SELECT"
            ? cellValue
                .split(",")
                .map((v) => v.trim())
                .filter(Boolean)
            : [cellValue.trim()];

        const weightRegex = /^(.+?)\s*\((\d+)%\)$/;
        const options: Array<{ value: string; weight?: number }> = [];

        for (const rawVal of rawValues) {
          const weightMatch = weightRegex.exec(rawVal);
          let displayText = rawVal;
          let weight = 100;
          if (weightMatch) {
            displayText = weightMatch[1].trim();
            weight = parseInt(weightMatch[2], 10);
          }

          const matchedOption = attribute.options.find(
            (opt) => opt.value.toLowerCase() === displayText.toLowerCase()
          );

          if (matchedOption) {
            options.push({
              value: matchedOption.id,
              ...(attribute.isWeightsEnabled ? { weight } : {}),
            });
          }
        }

        if (options.length > 0) {
          parsedAttributes.push({
            id: attribute.id,
            options,
          });
        }
      }
    }

    users.push({
      email,
      role,
      ...(parsedAttributes.length > 0 ? { attributes: parsedAttributes } : {}),
    });
  }

  if (users.length === 0) {
    throw new Error(t("no_valid_email_addresses_found"));
  }

  return users;
}

export function showImportSuccessToast(
  data: {
    numUsersInvited: number;
    numExistingUsersUpdated?: number;
    numAttributesFailed?: number;
  },
  t: (key: string, params?: Record<string, unknown>) => string
) {
  if (data.numAttributesFailed && data.numAttributesFailed > 0) {
    showToast(
      t("import_members_invited_updated_failed", {
        invited: data.numUsersInvited,
        updated: data.numExistingUsersUpdated ?? 0,
        failed: data.numAttributesFailed,
      }),
      "warning"
    );
  } else if (data.numExistingUsersUpdated && data.numExistingUsersUpdated > 0) {
    showToast(
      t("import_members_invited_updated", {
        invited: data.numUsersInvited,
        updated: data.numExistingUsersUpdated,
      }),
      "success"
    );
  } else {
    showToast(t("import_members_invited", { invited: data.numUsersInvited }), "success");
  }
}
