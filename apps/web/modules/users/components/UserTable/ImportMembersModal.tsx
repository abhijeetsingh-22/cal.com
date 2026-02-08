import { useLocale } from "@calcom/lib/hooks/useLocale";
import { CreationSource, MembershipRole } from "@calcom/prisma/enums";
import { trpc } from "@calcom/trpc/react";
import { isEmail } from "@calcom/trpc/server/routers/viewer/teams/util";
import { Badge } from "@calcom/ui/components/badge";
import { Button } from "@calcom/ui/components/button";
import { Dialog, DialogContent, DialogFooter } from "@calcom/ui/components/dialog";
import { Form, Label, Select } from "@calcom/ui/components/form";
import { Icon } from "@calcom/ui/components/icon";
import { showToast } from "@calcom/ui/components/toast";
import usePlatformMe from "@calcom/web/components/settings/platform/hooks/usePlatformMe";
import { useSession } from "next-auth/react";
import { useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import type { UserTableAction } from "./types";

interface Props {
  dispatch: React.Dispatch<UserTableAction>;
}

type MembershipRoleOption = {
  value: MembershipRole;
  label: string;
};

interface UserInvitation {
  email: string;
  role: MembershipRole;
  attributes?: Array<{
    id: string;
    value?: string;
    options?: Array<{ value: string; weight?: number }>;
  }>;
}

interface FormValues {
  defaultRole: MembershipRole;
}

function stripBOM(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

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

export function ImportMembersModal(props: Props) {
  const { data: session } = useSession();
  const { data: platformUser } = usePlatformMe();
  const utils = trpc.useUtils();
  const { t, i18n } = useLocale();
  const [parsedUsers, setParsedUsers] = useState<UserInvitation[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: attributes } = trpc.viewer.attributes.list.useQuery();
  const enabledAttributes = attributes?.filter((attr) => attr.enabled);

  const inviteMemberMutation = trpc.viewer.teams.inviteMember.useMutation({
    onSuccess: (data) => {
      props.dispatch({ type: "CLOSE_MODAL" });
      utils.viewer.organizations.listMembers.invalidate();

      if (data.numAttributesFailed && data.numAttributesFailed > 0) {
        showToast(
          t("import_complete_with_attribute_failures", {
            invited: data.numUsersInvited,
            updated: data.numExistingUsersUpdated ?? 0,
            assigned: data.numAttributesAssigned ?? 0,
            failed: data.numAttributesFailed,
          }),
          "warning"
        );
      } else if (data.numAttributesAssigned && data.numAttributesAssigned > 0) {
        showToast(
          t("import_complete_with_attributes", {
            invited: data.numUsersInvited,
            updated: data.numExistingUsersUpdated ?? 0,
            assigned: data.numAttributesAssigned,
          }),
          "success"
        );
      } else if (data.numExistingUsersUpdated && data.numExistingUsersUpdated > 0) {
        showToast(
          t("email_invite_team_bulk_with_updates", {
            userCount: data.numUsersInvited,
            updatedCount: data.numExistingUsersUpdated,
          }),
          "success"
        );
      } else {
        showToast(t("email_invite_team_bulk", { userCount: data.numUsersInvited }), "success");
      }
    },
    onError: (error) => {
      showToast(error.message, "error");
    },
  });

  const form = useForm<FormValues>({
    defaultValues: {
      defaultRole: MembershipRole.MEMBER,
    },
  });

  const orgId = session?.user.org?.id ?? platformUser?.organizationId;
  if (!orgId) return null;

  const roleOptions: MembershipRoleOption[] = [
    { value: MembershipRole.MEMBER, label: t("member") },
    { value: MembershipRole.ADMIN, label: t("admin") },
    { value: MembershipRole.OWNER, label: t("owner") },
  ];

  const handleFileUpload = (files: FileList | null) => {
    if (!files?.length) {
      return;
    }

    setParseError(null);
    setParsedUsers([]);

    const file = files[0];
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const contents = stripBOM(e?.target?.result as string);
        const lines = contents.split("\n");

        const headers = parseCSVRow(lines[0]);
        const emailIndex = headers.findIndex((h) => h.toLowerCase() === "members");
        const roleIndex = headers.findIndex((h) => h.toLowerCase() === "role");

        if (emailIndex === -1) {
          throw new Error(t("csv_file_must_have_members_column"));
        }

        const attributeColumns: Array<{
          columnIndex: number;
          attribute: NonNullable<typeof enabledAttributes>[number];
        }> = [];

        if (enabledAttributes) {
          headers.forEach((header, colIndex) => {
            if (colIndex === emailIndex || colIndex === roleIndex) return;
            const matchedAttr = enabledAttributes.find(
              (attr) => attr.name.toLowerCase() === header.toLowerCase()
            );
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

          if (!email || !isEmail(email)) {
            continue;
          }

          let role = form.getValues("defaultRole");
          if (roleIndex !== -1 && columns[roleIndex]) {
            const roleValue = columns[roleIndex].trim().toUpperCase();
            if (Object.values(MembershipRole).includes(roleValue as MembershipRole)) {
              role = roleValue as MembershipRole;
            }
          }

          const parsedAttributes: UserInvitation["attributes"] = [];

          for (const { columnIndex, attribute } of attributeColumns) {
            const cellValue = columns[columnIndex]?.trim();
            if (!cellValue) continue;

            if (attribute.type === "TEXT" || attribute.type === "NUMBER") {
              parsedAttributes.push({
                id: attribute.id,
                value: cellValue,
              });
            } else if (attribute.type === "SINGLE_SELECT" || attribute.type === "MULTI_SELECT") {
              const rawValues =
                attribute.type === "MULTI_SELECT"
                  ? cellValue
                      .split(";")
                      .map((v) => v.trim())
                      .filter(Boolean)
                  : [cellValue.trim()];

              const weightRegex = /^(.+?)\s*\((\d+)%\)$/;
              const options: Array<{ value: string; weight?: number }> = [];

              for (const rawVal of rawValues) {
                const weightMatch = weightRegex.exec(rawVal);
                const displayText = weightMatch ? weightMatch[1].trim() : rawVal;
                const weight = weightMatch ? parseInt(weightMatch[2], 10) : undefined;

                const matchedOption = attribute.options.find(
                  (opt) => opt.value.toLowerCase() === displayText.toLowerCase()
                );

                if (matchedOption) {
                  options.push({
                    value: matchedOption.id,
                    ...(weight !== undefined ? { weight } : {}),
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
        setParsedUsers(users);
      } catch (error) {
        setParseError((error as Error).message);
      }
    };

    reader.readAsText(file);
  };

  const handleSubmit = () => {
    if (parsedUsers.length === 0) {
      return;
    }

    inviteMemberMutation.mutateAsync({
      teamId: orgId,
      usernameOrEmail: parsedUsers.map((u) => ({
        email: u.email,
        role: u.role,
        ...(u.attributes?.length ? { attributes: u.attributes } : {}),
      })),
      language: i18n.language,
      isPlatform: platformUser?.organization.isPlatform,
      creationSource: CreationSource.WEBAPP,
    });
  };

  const resetForm = () => {
    form.reset();
    setParsedUsers([]);
    setParseError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  return (
    <Dialog
      name="importModal"
      open={true}
      onOpenChange={() => {
        props.dispatch({ type: "CLOSE_MODAL" });
        resetForm();
      }}>
      <DialogContent enableOverflow type="creation" title={t("import_team_members")}>
        <Form form={form} handleSubmit={handleSubmit}>
          <div className="mb-10 space-y-6">
            {parsedUsers.length === 0 && (
              <Controller
                name="defaultRole"
                control={form.control}
                render={({ field: { onChange, value } }) => (
                  <div>
                    <Label className="text-emphasis font-medium" htmlFor="defaultRole">
                      {t("default_role_for_imported_users")}
                    </Label>
                    <Select
                      id="role"
                      defaultValue={roleOptions[0]}
                      options={roleOptions}
                      onChange={(val) => {
                        if (val) onChange(val.value);
                      }}
                    />
                    <p className="text-subtle mt-2 text-sm">{t("role_applied_if_not_specified_in_csv")}</p>
                  </div>
                )}
              />
            )}

            {parsedUsers.length > 0 && (
              <div>
                <div className="mt-2 max-h-60 overflow-y-auto rounded-md border p-2">
                  <table className="w-full">
                    <thead>
                      <tr className="text-subtle border-b text-sm">
                        <th className="pb-2 text-left">{t("email")}</th>
                        <th className="pb-2 text-left">{t("role")}</th>
                        {enabledAttributes?.map((attr) => {
                          const hasValues = parsedUsers.some((u) =>
                            u.attributes?.some((a) => a.id === attr.id)
                          );
                          if (!hasValues) return null;
                          return (
                            <th key={attr.id} className="pb-2 text-left">
                              {attr.name}
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {parsedUsers.map((user, index) => (
                        <tr key={index} className="border-b last:border-b-0">
                          <td className="py-2">{user.email}</td>
                          <td className="py-2">
                            <Badge variant={user.role === "MEMBER" ? "gray" : "blue"} className="capitalize">
                              {user.role.toLowerCase()}
                            </Badge>
                          </td>
                          {enabledAttributes?.map((attr) => {
                            const hasValues = parsedUsers.some((u) =>
                              u.attributes?.some((a) => a.id === attr.id)
                            );
                            if (!hasValues) return null;
                            const userAttr = user.attributes?.find((a) => a.id === attr.id);
                            return (
                              <td key={attr.id} className="py-2">
                                {userAttr?.value && <Badge variant="gray">{userAttr.value}</Badge>}
                                {userAttr?.options?.map((opt) => {
                                  const optionData = attr.options.find((o) => o.id === opt.value);
                                  return (
                                    <Badge key={opt.value} variant="gray" className="mr-1">
                                      {optionData?.value ?? opt.value}
                                      {opt.weight !== undefined ? ` (${opt.weight}%)` : ""}
                                    </Badge>
                                  );
                                })}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="bg-muted mt-4 rounded-md p-4">
              <div className="flex items-center">
                <Icon name="info" className="text-subtle mr-2 h-4 w-4" />
                <p className="text-subtle text-sm">{t("csv_format_info")}</p>
              </div>
              <div className="mt-2">
                <p className="text-subtle text-sm">
                  {t("required_columns")}: <code className="text-xs">Members</code>
                </p>
                <p className="text-subtle text-sm">
                  {t("optional_columns")}: <code className="text-xs">Role</code> ({t("values")}: MEMBER,
                  ADMIN, OWNER)
                  {enabledAttributes && enabledAttributes.length > 0 && (
                    <>
                      {", "}
                      {enabledAttributes.map((attr, idx) => (
                        <span key={attr.id}>
                          <code className="text-xs">{attr.name}</code>
                          {idx < enabledAttributes.length - 1 ? ", " : ""}
                        </span>
                      ))}
                    </>
                  )}
                </p>
              </div>
              <div className="mt-2">
                <p className="text-subtle text-sm">{t("example")}:</p>
                <pre className="bg-subtle mt-1 rounded p-2 text-xs">
                  Members,Role{"\n"}
                  john@example.com,MEMBER{"\n"}
                  jane@example.com,ADMIN
                </pre>
              </div>
            </div>

            <div className="flex flex-col space-y-2">
              <div className="flex items-center">
                <Button
                  type="button"
                  color="secondary"
                  className="w-full justify-center stroke-2"
                  StartIcon="paperclip"
                  onClick={() => fileInputRef.current?.click()}>
                  {t("upload_csv_file")}
                </Button>
                <input
                  id="csvFile"
                  name="csvFile"
                  ref={fileInputRef}
                  type="file"
                  accept=".csv"
                  className="hidden"
                  onChange={(e) => handleFileUpload(e.target.files)}
                />
              </div>
              {parseError && <p className="text-sm text-red-800">{parseError}</p>}
            </div>
          </div>

          <DialogFooter showDivider>
            <Button
              type="button"
              color="minimal"
              onClick={() => {
                props.dispatch({ type: "CLOSE_MODAL" });
                resetForm();
              }}>
              {t("cancel")}
            </Button>
            <Button
              type="submit"
              loading={inviteMemberMutation.isPending}
              disabled={parsedUsers.length === 0}>
              {t("send_invite")}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
