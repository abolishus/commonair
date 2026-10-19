// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PasswordField } from "@commonair/ui/blocks/forms";
import type * as React from "react";
import { t } from "../i18n/index.ts";

/*
 * The two password inputs of the auth forms. Their e1 test ids reach the `<input>` only through
 * `PasswordField`'s `inputProps`, so they live here, where tests/selectors-render.test.tsx renders
 * them. (Declared as constants: an inline literal's `data-testid` key would be an excess property.)
 */
const signInInput = {
  "data-testid": "signin-password",
  name: "password",
  autoComplete: "current-password",
  required: true,
};

const signUpInput = {
  "data-testid": "signup-password",
  name: "password",
  autoComplete: "new-password",
  required: true,
  minLength: 10,
  maxLength: 256,
};

export function SignInPasswordField(): React.JSX.Element {
  return (
    <PasswordField
      label={t("field.password")}
      showLabel={t("field.showPassword")}
      hideLabel={t("field.hidePassword")}
      inputProps={signInInput}
    />
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
