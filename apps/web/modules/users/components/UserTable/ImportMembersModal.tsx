import { Dialog } from "@calcom/features/components/controlled-dialog";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { CreationSource, MembershipRole } from "@calcom/prisma/enums";
import { trpc } from "@calcom/trpc/react";
import { Badge } from "@calcom/ui/components/badge";
import { Button } from "@calcom/ui/components/button";
import { DialogContent, DialogFooter } from "@calcom/ui/components/dialog";
import { Form, Label, Select } from "@calcom/ui/components/form";
import { Icon } from "@calcom/ui/components/icon";
import { showToast } from "@calcom/ui/components/toast";
import usePlatformMe from "@calcom/web/components/settings/platform/hooks/usePlatformMe";
import { LimitedBadges } from "@calcom/web/components/ui/LimitedBadges";
import type { AttributeDefinition, UserInvitation } from "@calcom/web/modules/users/lib/ImportMembersUtils";
import {
  parseCSVContent,
  showImportSuccessToast,
  stripBOM,
} from "@calcom/web/modules/users/lib/ImportMembersUtils";
import { useSession } from "next-auth/react";
import { useMemo, useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import type { UserTableAction } from "./types";

interface Props {
  dispatch: React.Dispatch<UserTableAction>;
}

type MembershipRoleOption = {
  value: MembershipRole;
  label: string;
};

interface FormValues {
  defaultRole: MembershipRole;
}

interface PreviewTableProps {
  parsedUsers: UserInvitation[];
  enabledAttributes?: AttributeDefinition[];
}

function PreviewTable({ parsedUsers, enabledAttributes }: PreviewTableProps) {
  const { t } = useLocale();

  const attributeIdsWithValues = useMemo(() => {
    const ids = new Set<string>();
    for (const user of parsedUsers) {
      for (const attr of user.attributes ?? []) {
        ids.add(attr.id);
      }
    }
    return ids;
  }, [parsedUsers]);

  const optionLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const attr of enabledAttributes ?? []) {
      for (const opt of attr.options) {
        map.set(opt.id, opt.value);
      }
    }
    return map;
  }, [enabledAttributes]);

  return (
    <div>
      <div className="scrollbar-thin mt-2 max-h-60 overflow-auto rounded-md border">
        <table className="min-w-full">
          <thead>
            <tr className="border-b text-sm text-subtle">
              <th className="min-w-[200px] px-3 py-2 text-left">{t("email")}</th>
              <th className="min-w-[100px] px-3 py-2 text-left">{t("role")}</th>
              {enabledAttributes?.map((attr) => {
                if (!attributeIdsWithValues.has(attr.id)) return null;
                return (
                  <th key={attr.id} className="min-w-[120px] px-3 py-2 text-left">
                    {attr.name}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {parsedUsers.map((user, index) => (
              <tr key={index} className="border-b last:border-b-0">
                <td className="px-3 py-2.5">{user.email}</td>
                <td className="px-3 py-2.5">
                  <Badge variant={user.role === "MEMBER" ? "gray" : "blue"} className="capitalize">
                    {user.role.toLowerCase()}
                  </Badge>
                </td>
                {enabledAttributes?.map((attr) => {
                  if (!attributeIdsWithValues.has(attr.id)) return null;
                  const userAttr = user.attributes?.find((a) => a.id === attr.id);
                  if (!userAttr) return <td key={attr.id} className="px-3 py-2.5" />;

                  const badgeItems: Array<{ label: string; variant: "gray" }> = [];
                  if (userAttr.value) {
                    badgeItems.push({ label: userAttr.value, variant: "gray" });
                  }
                  if (userAttr.options) {
                    for (const opt of userAttr.options) {
                      let label = optionLabelById.get(opt.value) ?? opt.value;
                      if (attr.isWeightsEnabled) {
                        label = `${label} ${opt.weight}%`;
                      }
                      badgeItems.push({ label, variant: "gray" });
                    }
                  }

                  return (
                    <td key={attr.id} className="px-3 py-2.5">
                      <LimitedBadges items={badgeItems} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CSVFormatInfo({ enabledAttributes }: { enabledAttributes?: AttributeDefinition[] }) {
  const { t } = useLocale();

  return (
    <div className="mt-4 rounded-md bg-muted p-4">
      <div className="flex items-center">
        <Icon name="info" className="mr-2 h-4 w-4 text-subtle" />
        <p className="text-sm text-subtle">{t("csv_format_info")}</p>
      </div>
      <div className="mt-2">
        <p className="text-sm text-subtle">
          {t("required_columns")}: <code className="text-xs">Members</code>
        </p>
        <p className="text-sm text-subtle">
          {t("optional_columns")}: <code className="text-xs">Role</code> ({t("values")}: MEMBER, ADMIN, OWNER)
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
        <p className="text-sm text-subtle">{t("example")}:</p>
        <pre className="mt-1 rounded bg-subtle p-2 text-xs">
          Members,Role{"\n"}
          john@example.com,MEMBER{"\n"}
          jane@example.com,ADMIN
        </pre>
      </div>
    </div>
  );
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
  const importMembersMutation = trpc.viewer.teams.importMembers.useMutation({
    onSuccess: (data) => {
      props.dispatch({ type: "CLOSE_MODAL" });
      utils.viewer.organizations.listMembers.invalidate();
      showImportSuccessToast(data, t);
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

  const handleFileUpload = (files: FileList | null): void => {
    if (!files?.length) return;

    setParseError(null);
    setParsedUsers([]);

    const reader = new FileReader();
    reader.onload = (e): void => {
      try {
        const rawResult = e?.target?.result;
        if (typeof rawResult !== "string") return;
        const csvText = stripBOM(rawResult);
        const users = parseCSVContent({
          csvText,
          enabledAttributes,
          defaultRole: form.getValues("defaultRole"),
          t,
        });
        setParsedUsers(users);
      } catch (error) {
        setParseError((error as Error).message);
      }
    };
    reader.onerror = (): void => {
      setParseError(t("error_reading_file"));
    };
    reader.readAsText(files[0]);
  };

  const handleSubmit = (): void => {
    if (parsedUsers.length === 0 || importMembersMutation.isPending) return;
    importMembersMutation.mutate({
      teamId: orgId,
      members: parsedUsers.map((u) => ({
        email: u.email,
        role: u.role,
        ...(u.attributes?.length ? { attributes: u.attributes } : {}),
      })),
      language: i18n.language,
      creationSource: CreationSource.WEBAPP,
    });
  };

  const resetForm = (): void => {
    form.reset();
    setParsedUsers([]);
    setParseError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
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
                render={({ field: { onChange } }): React.ReactElement => (
                  <div>
                    <Label className="font-medium text-emphasis" htmlFor="defaultRole">
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
                    <p className="mt-2 text-sm text-subtle">{t("role_applied_if_not_specified_in_csv")}</p>
                  </div>
                )}
              />
            )}

            {parsedUsers.length > 0 && (
              <PreviewTable parsedUsers={parsedUsers} enabledAttributes={enabledAttributes} />
            )}

            <CSVFormatInfo enabledAttributes={enabledAttributes} />

            <div className="flex flex-col space-y-2">
              <div className="flex items-center">
                <Button
                  type="button"
                  color="secondary"
                  className="w-full justify-center stroke-2"
                  StartIcon="paperclip"
                  onClick={() => {
                    if (fileInputRef.current) {
                      fileInputRef.current.value = "";
                    }
                    fileInputRef.current?.click();
                  }}>
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
              {parseError && <p className="text-red-800 text-sm">{parseError}</p>}
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
              loading={importMembersMutation.isPending}
              disabled={parsedUsers.length === 0 || importMembersMutation.isPending}>
              {t("send_invite")}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
