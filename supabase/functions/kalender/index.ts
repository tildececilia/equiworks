// ============================================================
//  EQUIWORKS – KALENDERPRENUMERATION
//  Svarar med en ICS-fil (text/calendar) som telefonens kalender
//  hämtar med jämna mellanrum. Länken innehåller en hemlig token
//  som pekar ut personen — ingen inloggning behövs.
//
//  Anrop:  GET /smart-api?t=<token>
//  (funktionen fick Supabases föreslagna namn "smart-api" när den
//   skapades i editorn — namnet går inte att byta i efterhand, så
//   appens CAL_FN pekar dit i stället)
//
//  VIKTIGT vid deploy i Supabase → Edge Functions:
//    slå AV "Verify JWT" för den här funktionen, annars kommer
//    kalenderappen inte in (den kan inte skicka någon token i
//    headern). Hemligheten ligger i stället i ?t=.
//  SUPABASE_URL och SUPABASE_SERVICE_ROLE_KEY sätts automatiskt.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PRODID = "-//EquiWorks//Jourpass//SV";

// Sveriges tidszon, så kalendern lägger passen rätt även över sommartid.
const VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Stockholm",
  "X-LIC-LOCATION:Europe/Stockholm",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "TZNAME:CEST",
  "DTSTART:19700329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "TZNAME:CET",
  "DTSTART:19701025T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
];

type Rad = {
  booking_id: string;
  pass_date: string;
  start_time: string | null;
  pass_name: string;
  description: string | null;
  is_task: boolean;
  stable_name: string;
  profile_name: string;
};

// ICS tål inte hur som helst: komma, semikolon, backslash och radbrytning måste maskas.
const esc = (s: string) =>
  String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

// Rader längre än 75 tecken ska brytas med ett mellanslag först på nästa rad.
// Gränsen räknas i bytes, så vi viker vid 70 tecken för att ha marginal för
// å, ä och ö som tar två bytes var.
function vikRad(rad: string): string[] {
  const ut: string[] = [];
  let r = rad;
  while (r.length > 70) {
    ut.push(r.slice(0, 70));
    r = " " + r.slice(70);
  }
  ut.push(r);
  return ut;
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";

function dagEfter(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function handelse(r: Rad): string[] {
  const dag = r.pass_date.replace(/-/g, "");
  const tid = (r.start_time || "").trim();
  const rader = [
    "BEGIN:VEVENT",
    `UID:${r.booking_id}@equiworks`,
    `DTSTAMP:${stamp()}`,
  ];
  if (tid && /^\d{1,2}:\d{2}/.test(tid) && !r.is_task) {
    // vanligt pass: en timme från starttiden
    const [h, m] = tid.split(":");
    const start = `${dag}T${h.padStart(2, "0")}${m.padStart(2, "0")}00`;
    const slutH = String((parseInt(h, 10) + 1) % 24).padStart(2, "0");
    const slutDag = parseInt(h, 10) + 1 >= 24 ? dagEfter(r.pass_date).replace(/-/g, "") : dag;
    rader.push(`DTSTART;TZID=Europe/Stockholm:${start}`);
    rader.push(`DTEND;TZID=Europe/Stockholm:${slutDag}T${slutH}${m.padStart(2, "0")}00`);
  } else {
    // uppgift eller pass utan klockslag: heldag
    rader.push(`DTSTART;VALUE=DATE:${dag}`);
    rader.push(`DTEND;VALUE=DATE:${dagEfter(r.pass_date).replace(/-/g, "")}`);
  }
  rader.push(`SUMMARY:${esc(r.pass_name + " · " + r.stable_name)}`);
  const besk = [r.description || "", `Bokat på ${r.profile_name}.`].filter(Boolean).join("\n\n");
  rader.push(`DESCRIPTION:${esc(besk)}`);
  rader.push(`LOCATION:${esc(r.stable_name)}`);
  rader.push("END:VEVENT");
  return rader;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const token = (url.searchParams.get("t") || "").trim();
  const rubriker = {
    "Content-Type": "text/calendar; charset=utf-8",
    "Cache-Control": "public, max-age=900",
    "Access-Control-Allow-Origin": "*",
  };
  if (!token) return new Response("saknar token", { status: 400 });

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { data, error } = await db.rpc("cal_bookings", { p_token: token });
  if (error) {
    console.log("STOPP: kunde inte hämta pass —", error.message);
    return new Response("fel: " + error.message, { status: 500 });
  }
  const rader = (data || []) as Rad[];
  console.log("kalender hämtad, antal pass:", rader.length);

  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:EquiWorks – mina pass",
    "X-WR-TIMEZONE:Europe/Stockholm",
    "REFRESH-INTERVAL;VALUE=DURATION:PT2H",
    "X-PUBLISHED-TTL:PT2H",
    ...VTIMEZONE,
    ...rader.flatMap(handelse),
    "END:VCALENDAR",
  ].flatMap(vikRad).join("\r\n") + "\r\n";

  return new Response(ics, { headers: rubriker });
});
