import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { signIn } from "@/lib/auth/config";
import { Input } from "@/components/ui/input";
import { SignInButton } from "./sign-in-button";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; error?: string; identifier?: string }>;
}) {
  const sp = await searchParams;
  const errorMessage =
    sp.error === "CredentialsSignin"
      ? "Wrong username or password."
      : sp.error
        ? `Sign-in error: ${sp.error}`
        : null;

  // The admin layout already supplies the page <main> element and the
  // "← home" link, so this page renders only the sign-in card.
  return (
    <div className="mx-auto max-w-md py-8">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight">Instructor and reviewer sign-in</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          For the instructor account and the read-only reviewer account. Learners join through an invite link from their instructor and do not sign in.
        </p>

        {errorMessage ? (
          <div
            role="alert"
            className="mt-6 animate-slide-down rounded-md border border-flag/40 bg-flag/5 px-3 py-2 text-sm text-flag"
          >
            {errorMessage}
          </div>
        ) : null}

        <form
          action={async (formData) => {
            "use server";
            const identifier = String(formData.get("email") ?? "");
            try {
              await signIn("credentials", {
                email: formData.get("email"),
                password: formData.get("password"),
                redirectTo: sp.callbackUrl ?? "/admin",
              });
            } catch (error) {
              // A successful sign-in throws NEXT_REDIRECT, which must propagate.
              // A failed credential check throws AuthError, so convert it to a
              // redirect back to this page with ?error= so the inline message
              // renders instead of an opaque 500.
              if (error instanceof AuthError) {
                const code =
                  error.type === "CredentialsSignin" ? "CredentialsSignin" : error.type;
                const qs = new URLSearchParams({ error: code });
                if (sp.callbackUrl) qs.set("callbackUrl", sp.callbackUrl);
                // Carry the identifier back so a failed sign-in does not make
                // the instructor retype it; the password is always cleared.
                if (identifier) qs.set("identifier", identifier);
                redirect(`/admin/login?${qs.toString()}`);
              }
              throw error;
            }
          }}
          className="mt-6 space-y-4"
        >
          <div>
            <label htmlFor="email" className="block text-sm font-medium">
              Email or username
            </label>
            <Input
              id="email"
              name="email"
              type="text"
              required
              autoComplete="username"
              autoFocus
              defaultValue={sp.identifier ?? ""}
              className="mt-1.5"
            />
          </div>
          <div>
            <label htmlFor="password" className="block text-sm font-medium">
              Password
            </label>
            <Input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="mt-1.5"
            />
          </div>
          <SignInButton />
        </form>
      </section>
    </div>
  );
}
