// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sample data from the SignIn board (sign up). */
export const tabs = [
  { id: "signup", label: "Sign up", href: "#signup", current: true },
  { id: "signin", label: "Sign in", href: "#signin" },
];

export const form = {
  username: "mothwing",
  usernameHint: "Your channel lives at /mothwing. 3–25 letters, numbers or underscores.",
  emailPlaceholder: "you@example.org",
  password: "correct-horse-battery",
  strength: { value: 100, label: "Strong" },
  passwordHint: "Strong. At least 12 characters.",
  dobHint: "You must be 13 or older. Mature streams need 18+.",
  years: Array.from({ length: 100 }, (_, index) => 2026 - index),
};

export const benefits = [
  "Stream from minute one. No follower threshold to earn.",
  "Creators keep the majority of every subscription; the split is set by member vote.",
  "No ads, trackers or third-party scripts on any page.",
  "Export or delete your data any time.",
];
