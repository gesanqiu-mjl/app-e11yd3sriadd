CREATE OR REPLACE FUNCTION public.update_resource_sort_orders(p_items jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  item jsonb;
BEGIN
  FOR item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    UPDATE resources
    SET sort_order = (item->>'sort_order')::int,
        updated_at = now()
    WHERE id = (item->>'id')::uuid
      AND owner_id = auth.uid();
  END LOOP;
END;
$$;