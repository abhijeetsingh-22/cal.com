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
  const lines = csvText.split(/\r?\n/);
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
  const seenEmails = new Set<string>();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const columns = parseCSVRow(line);
    const email = columns[emailIndex]?.trim()?.toLowerCase();

    if (!email || !emailRegex.test(email) || seenEmails.has(email)) {
      continue;
    }
    seenEmails.add(email);

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
        // Exported attribute values may include a default weight suffix e.g. "Engineering (100%)" — strip it for TEXT/NUMBER types
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
    numUsersUpdated: number;
    numUpdatesFailed: number;
  },
  t: (key: string, params?: Record<string, unknown>) => string
) {
  const parts: string[] = [];
  if (data.numUsersInvited > 0) parts.push(t("import_result_invited", { count: data.numUsersInvited }));
  if (data.numUsersUpdated > 0) parts.push(t("import_result_updated", { count: data.numUsersUpdated }));
  if (data.numUpdatesFailed > 0)
    parts.push(t("import_result_update_failed", { count: data.numUpdatesFailed }));

  if (parts.length === 0) {
    showToast(t("import_all_up_to_date"), "success");
  } else {
    showToast(parts.join(", "), data.numUpdatesFailed > 0 ? "warning" : "success");
  }
}
