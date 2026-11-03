// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PasswordField } from "@commonair/ui/blocks/forms";
import type * as React from "react";
import { t } from "../i18n/index.ts";

/*
 * The password inputs of the auth forms. Their e1 test ids reach the `<input>` only through
 * `PasswordField`'s `inputProps`, so they live here, where tests/selectors-render.test.tsx renders
 * them. (Declared as constants: an inline literal's `data-testid` key would be an excess property.)
 */
const signInInput = {
  "data-testid": "signin-password",
  name: "password",
  autoComplete: "current-password",
  required: true,
};

/** The API's rules (better-auth `minPasswordLength`/`maxPasswordLength`), checked again there. */
const newPasswordRules = { minLength: 10, maxLength: 256 };

const signUpInput = {
  "data-testid": "signup-password",
  name: "password",
  autoComplete: "new-password",
  required: true,
  ...newPasswordRules,
};

const resetInput = {
  "data-testid": "reset-password-new",
  name: "password",
  autoComplete: "new-password",
  required: true,
  ...newPasswordRules,
};

export interface SignInPasswordFieldProps {
  /** Under the field, end-aligned: the "Forgot password?" link (F17). */
  forgotPassword?: React.ReactNode;
}

export function SignInPasswordField({ forgotPassword }: SignInPasswordFieldProps = {}): React.JSX.Element {
  const field = (
    <PasswordField
      label={t("field.password")}
      showLabel={t("field.showPassword")}
      hideLabel={t("field.hidePassword")}
      inputProps={signInInput}
    />
  );
  if (!forgotPassword) return field;
  return (
    <div className="flex flex-col gap-1">
      {field}
      <div className="flex justify-end">{forgotPassword}</div>
    </div>
  );
}

export function SignUpPasswordField(): React.JSX.Element {
  return (
    <PasswordField
      label={t("field.password")}
      showLabel={t("field.showPassword")}
      hideLabel={t("field.hidePassword")}
      description={t("signup.passwordHint")}
      inputProps={signUpInput}
    />
  );
}

/** The new password on the reset form (the link from the reset email lands on `/signin?token=`). */
export function ResetPasswordField(): React.JSX.Element {
  return (
    <PasswordField
      label={t("polish.auth.reset.newTitle")}
      showLabel={t("field.showPassword")}
      hideLabel={t("field.hidePassword")}
      description={t("signup.passwordHint")}
      inputProps={resetInput}
    />
  );
}
