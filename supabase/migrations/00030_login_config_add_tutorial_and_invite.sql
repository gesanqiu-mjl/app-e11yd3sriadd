ALTER TABLE public.login_config
  ADD COLUMN IF NOT EXISTS tutorial_url text,
  ADD COLUMN IF NOT EXISTS invite_code_info text;