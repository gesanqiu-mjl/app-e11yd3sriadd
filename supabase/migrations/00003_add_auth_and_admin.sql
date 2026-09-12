-- 用户角色枚举
CREATE TYPE public.user_role AS ENUM ('user', 'admin');

-- 用户档案表
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text,
  phone text,
  username text,
  role public.user_role NOT NULL DEFAULT 'user',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- 新用户自动同步到 profiles；首位注册用户自动成为管理员
CREATE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  is_first boolean;
BEGIN
  SELECT (count(*) = 0) INTO is_first FROM public.profiles;
  INSERT INTO public.profiles (id, email, phone, username, role)
  VALUES (
    NEW.id,
    NEW.email,
    NEW.phone,
    COALESCE(NEW.raw_user_meta_data->>'username', split_part(NEW.email, '@', 1)),
    CASE WHEN is_first THEN 'admin'::public.user_role ELSE 'user'::public.user_role END
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- 角色查询辅助函数（避免 RLS 自循环）
CREATE OR REPLACE FUNCTION public.get_user_role(uid uuid)
RETURNS public.user_role
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM public.profiles WHERE id = uid;
$$;

-- profiles 策略
CREATE POLICY "Admins have full access to profiles" ON public.profiles
  FOR ALL TO authenticated USING (public.get_user_role(auth.uid()) = 'admin'::public.user_role);
CREATE POLICY "Users can view their own profile" ON public.profiles
  FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY "Users can update their own profile" ON public.profiles
  FOR UPDATE TO authenticated USING (auth.uid() = id)
  WITH CHECK (role IS NOT DISTINCT FROM public.get_user_role(auth.uid()));

CREATE VIEW public.public_profiles AS
  SELECT id, username, role, created_at FROM public.profiles;

-- 资源表：增加 owner_id（先可空，回填后再设非空）
ALTER TABLE public.resources ADD COLUMN owner_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE;
ALTER TABLE public.resources ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Owner can view own resources" ON public.resources
  FOR SELECT TO authenticated USING (owner_id = auth.uid());
CREATE POLICY "Owner can insert own resources" ON public.resources
  FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid());
CREATE POLICY "Owner can update own resources" ON public.resources
  FOR UPDATE TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
CREATE POLICY "Owner can delete own resources" ON public.resources
  FOR DELETE TO authenticated USING (owner_id = auth.uid());
CREATE POLICY "Admin full access resources" ON public.resources
  FOR ALL TO authenticated USING (public.get_user_role(auth.uid()) = 'admin'::public.user_role);

-- 历史记录表：增加 user_id（先可空，回填后再设非空）
ALTER TABLE public.change_history ADD COLUMN user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE;
ALTER TABLE public.change_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Owner can view own history" ON public.change_history
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "Owner can insert own history" ON public.change_history
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "Admin full access history" ON public.change_history
  FOR ALL TO authenticated USING (public.get_user_role(auth.uid()) = 'admin'::public.user_role);