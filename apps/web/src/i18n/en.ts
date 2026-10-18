// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** English catalog. Keys are dotted by area; `{name}` placeholders are filled by `t()`. */
export const en = {
  "app.title": "Live streaming, owned by the people who make it",

  "nav.account": "Account",
  "nav.signIn": "Sign in",
  "nav.signUp": "Sign up",
  "nav.signOut": "Sign out",
  "nav.dashboardFor": "Dashboard for {name}",
  "auth.signOutFailed": "Could not sign out. Try again.",

  "footer.source": "Source",
  "footer.license": "Free software under the AGPL-3.0",

  "home.title": "Welcome to {name}",
  "home.tagline": "A member-owned cooperative for live streaming.",
  "home.toDashboard": "Go to your dashboard",

  "field.email": "Email",
  "field.username": "Username",
  "field.password": "Password",
  "field.birthDate": "Birth date",

  "signup.title": "Create your account",
  "signup.usernameHint": "3–25 lowercase letters, digits or underscores. This is also your channel address.",
  "signup.passwordHint": "At least 10 characters.",
  "signup.legalAccept": "I accept the current terms and policies",
  "signup.submit": "Create account",
  "signup.haveAccount": "Already a member?",
  "signup.checkEmailTitle": "Check your email",
  "signup.checkEmailBody": "We sent a verification link to {email}. Open it to finish signing up.",

  "signin.title": "Sign in",
  "signin.submit": "Sign in",
  "signin.noAccount": "New here?",

  "legal.version": "Version {version}",
  "legal.draft": "Draft pending legal review",

  "error.generic": "Something went wrong. Try again.",
  "error.altcha": "The anti-spam check failed. Wait for it to finish and try again.",
  "error.invalidUsername": "That username is not allowed. Use 3–25 lowercase letters, digits or underscores.",
  "error.usernameTaken": "That username is taken.",
  "error.userExists": "An account with this email already exists.",
  "error.invalidEmail": "Enter a valid email address.",
  "error.passwordTooShort": "The password is too short.",
  "error.passwordTooLong": "The password is too long.",
  "error.tooYoung": "You are not old enough to join.",
  "error.invalidBirthDate": "Enter a valid birth date.",
  "error.legalRequired": "Accept the current terms and policies to continue.",
  "error.invalidCredentials": "Wrong email or password.",
  "error.emailNotVerified": "Verify your email first: open the link we sent you.",
  "error.rateLimited": "Too many attempts. Wait a moment and try again.",

  "dashboard.title": "Creator dashboard",
  "dashboard.viewChannel": "View your channel",
  "dashboard.streamSetup": "Stream setup",
  "dashboard.streamSetupHint": "In OBS, set Service to Custom, then paste the server URL and your stream key.",
  "dashboard.serverUrl": "Server URL",
  "dashboard.activeKey": "Active stream key",
  "dashboard.noKey": "No key yet",
  "dashboard.newKey": "Your new stream key",
  "dashboard.newKeyOnce": "It is shown only once. Keep it secret: anyone with it can stream as you.",
  "dashboard.copyKey": "Copy stream key",
  "dashboard.keyCopied": "Stream key copied",
  "dashboard.copyFailed": "Could not copy. Select the key and copy it by hand.",
  "dashboard.createKey": "Create stream key",
  "dashboard.rotateKey": "Replace stream key",
  "dashboard.rotateConfirmTitle": "Replace your stream key?",
  "dashboard.rotateConfirmBody": "The current key stops working immediately. Update your encoder with the new one.",
  "dashboard.keyRotated": "New stream key created",
  "dashboard.rotateFailed": "Could not create a new key. Try again.",
  "dashboard.loadFailed": "Could not load your stream settings.",

  "channel.offline": "{name} is offline",
  "channel.notFound": "This channel does not exist",

  "player.loading": "Loading stream…",
  "player.error": "The stream could not be played.",
  "player.mute": "Mute",
  "player.unmute": "Unmute",

  "chat.title": "Chat",
  "chat.status.connecting": "Connecting…",
  "chat.status.open": "Connected",
  "chat.status.closed": "Disconnected",
  "chat.empty": "No messages yet",
  "chat.placeholder": "Send a message",
  "chat.send": "Send",
  "chat.notConnected": "Chat is not connected yet.",
  "chat.signInPrompt": "Sign in to chat.",
} as const;

export type MessageKey = keyof typeof en;
