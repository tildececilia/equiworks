// ============================================================
//  EQUIWORKS – INBJUDNINGSMEJL
//  Skickar ett eget mejl när någon läggs till i ett stall, i
//  stället för Supabases inloggningsmallar. Mejlet innehåller
//  bara en länk till appen — ingen kod, ingen tidsgräns.
//
//  Anropas från appen: db.functions.invoke("invite-mail", {...})
//  Bara admins i organisationen, eller medlemmar i just det
//  stallet, får skicka — kollas med servicenyckeln.
//
//  Hemligheter som måste finnas (Supabase → Edge Functions →
//  invite-mail → Secrets):
//    BREVO_API_KEY   nyckeln från Brevo (SMTP & API → API keys)
//    MAIL_FROM       avsändaradress, t.ex. tilde.cecilia@gmail.com
//    MAIL_FROM_NAME  avsändarnamn, t.ex. EquiWorks
//    APP_URL         https://tildececilia.github.io/equiworks/
//  SUPABASE_URL och SUPABASE_SERVICE_ROLE_KEY sätts automatiskt.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const svar = (kropp: unknown, status = 200) =>
  new Response(JSON.stringify(kropp), { status, headers: { ...cors, "Content-Type": "application/json" } });

function mejlHtml(stallNamn: string, avsandare: string, roll: string, appUrl: string) {
  const rollrad = roll ? `<p style="font-size:14px;line-height:1.5;margin:0 0 18px">Du är tillagd som <b>${roll}</b>.</p>` : "";
  return `<div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;padding:24px;color:#12352c">
  <h1 style="font-family:Georgia,serif;color:#14453a;font-size:26px;margin:0 0 6px">EquiWorks</h1>
  <p style="font-size:16px;line-height:1.5"><b>${avsandare}</b> har lagt till dig i <b>${stallNamn}</b>.</p>
  ${rollrad}
  <p style="font-size:16px;line-height:1.5">Öppna EquiWorks och logga in med den här mejladressen — du fyller i adressen, får en kod i mejlet och skriver in den. Din inbjudan väntar sedan i notisklockan uppe till höger.</p>
  <p style="margin:26px 0"><a href="${appUrl}" style="background:#14453a;color:#e8f2ea;text-decoration:none;padding:13px 26px;border-radius:10px;font-size:16px">Öppna EquiWorks</a></p>
  <p style="font-size:13px;color:#57695e;margin:0">Länken går alltid att använda — den slutar aldrig gälla.</p>
  <p style="font-size:13px;color:#57695e;margin-top:22px">Känner du inte igen det här kan du bortse från mejlet.</p>
</div>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return svar({ error: "Bara POST" }, 405);

  const nyckel = Deno.env.get("BREVO_API_KEY");
  if (!nyckel) return svar({ error: "BREVO_API_KEY saknas i funktionens secrets" }, 500);

  const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  if (!jwt) return svar({ error: "Inte inloggad" }, 401);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // vem ringer?
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  const avsandarMejl = userData?.user?.email?.toLowerCase();
  if (userErr || !avsandarMejl) return svar({ error: "Kunde inte läsa inloggningen" }, 401);

  let kropp: { email?: string; stable_id?: string; role?: string };
  try { kropp = await req.json(); } catch { return svar({ error: "Ogiltig JSON" }, 400); }

  const till = (kropp.email || "").trim().toLowerCase();
  const stallId = kropp.stable_id || "";
  if (!till.includes("@") || !stallId) return svar({ error: "email och stable_id krävs" }, 400);
  if (till === avsandarMejl) return svar({ ok: true, skipped: "egen adress" });

  // stallet och behörigheten: bara admin i organisationen får bjuda in
  const { data: stall } = await admin.from("stable").select("id,name,org_id").eq("id", stallId).single();
  if (!stall) return svar({ error: "Stallet finns inte" }, 404);
  const { data: adminrader } = await admin.from("org_admin").select("org_id").eq("email", avsandarMejl);
  let farSkicka = (adminrader || []).some((r: { org_id: string }) => r.org_id === stall.org_id);
  if (!farSkicka) {
    // även en vanlig medlem får lägga till en adress på sin egen profil
    const { data: medlem } = await admin
      .from("profile_member")
      .select("profile_id, profile!inner(stable_id)")
      .eq("email", avsandarMejl)
      .eq("profile.stable_id", stall.id);
    farSkicka = (medlem || []).length > 0;
  }
  if (!farSkicka) return svar({ error: "Du är inte med i det här stallet" }, 403);

  const appUrl = Deno.env.get("APP_URL") || "https://tildececilia.github.io/equiworks/";
  const svarPost = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": nyckel, "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: {
        email: Deno.env.get("MAIL_FROM") || "tilde.cecilia@gmail.com",
        name: Deno.env.get("MAIL_FROM_NAME") || "EquiWorks",
      },
      to: [{ email: till }],
      subject: `Du har lagts till i ${stall.name} – EquiWorks`,
      htmlContent: mejlHtml(stall.name, avsandarMejl, (kropp.role || "").trim(), appUrl),
    }),
  });

  if (!svarPost.ok) {
    const text = await svarPost.text();
    return svar({ error: "Brevo nekade utskicket: " + text }, 502);
  }
  return svar({ ok: true });
});
