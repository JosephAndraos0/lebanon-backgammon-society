/* Site settings. Fill in the two Supabase values (see README.md, step 1).
 * Both are PUBLIC by design - the anon key is safe in the browser because the database
 * rules (Row Level Security in supabase/schema.sql) decide who can read and write what.
 * NEVER put a "service_role" key or a Stripe secret key in this file. */
window.LBS_CONFIG = {
  SUPABASE_URL: "https://zginiziuxpulyexlicnf.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpnaW5peml1eHB1bHlleGxpY25mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAzNzU0MjMsImV4cCI6MjEwNTk1MTQyM30.bQahqxxFtnHp3kB8D1A4jU3bky9U0rxui00AIObQQz8",

  // Turn on once the Stripe functions in supabase/functions are deployed (README step 5).
  PAYMENTS_ENABLED: true,

  // Shown to players who reserve a seat while online payment is off.
  PAYMENT_INSTRUCTIONS: "We'll confirm your seat as soon as your entry fee is received. Contact us to arrange payment.",

  CONTACT_EMAIL: "lebanonbackgammonsociety@gmail.com",
  TIMEZONE: "Asia/Beirut"
};
