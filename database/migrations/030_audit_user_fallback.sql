-- 030_audit_user_fallback.sql
-- Attribute audit_logs.changed_by from row columns when app.current_user_id isn't set.

CREATE OR REPLACE FUNCTION public.fn_audit_row()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_user uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
    v_rec jsonb;
BEGIN
    IF (TG_OP = 'DELETE') THEN v_rec := to_jsonb(OLD); ELSE v_rec := to_jsonb(NEW); END IF;
    IF v_user IS NULL THEN
        v_user := COALESCE(
            NULLIF(v_rec->>'created_by',  '')::uuid,
            NULLIF(v_rec->>'cashier_id',  '')::uuid,
            NULLIF(v_rec->>'user_id',     '')::uuid,
            NULLIF(v_rec->>'received_by', '')::uuid,
            NULLIF(v_rec->>'approved_by', '')::uuid,
            NULLIF(v_rec->>'issued_by',   '')::uuid
        );
    END IF;
    IF (TG_OP = 'INSERT') THEN
        INSERT INTO audit_logs(table_name, record_id, operation, changed_by, new_data)
        VALUES (TG_TABLE_NAME, NEW.id::text, 'I', v_user, to_jsonb(NEW));
        RETURN NEW;
    ELSIF (TG_OP = 'UPDATE') THEN
        INSERT INTO audit_logs(table_name, record_id, operation, changed_by, old_data, new_data)
        VALUES (TG_TABLE_NAME, NEW.id::text, 'U', v_user, to_jsonb(OLD), to_jsonb(NEW));
        RETURN NEW;
    ELSE
        INSERT INTO audit_logs(table_name, record_id, operation, changed_by, old_data)
        VALUES (TG_TABLE_NAME, OLD.id::text, 'D', v_user, to_jsonb(OLD));
        RETURN OLD;
    END IF;
END;
$$;

UPDATE audit_logs
   SET changed_by = COALESCE(
     NULLIF(new_data->>'created_by',  '')::uuid,
     NULLIF(new_data->>'cashier_id',  '')::uuid,
     NULLIF(new_data->>'user_id',     '')::uuid,
     NULLIF(new_data->>'received_by', '')::uuid,
     NULLIF(new_data->>'approved_by', '')::uuid,
     NULLIF(new_data->>'issued_by',   '')::uuid,
     NULLIF(old_data->>'created_by',  '')::uuid,
     NULLIF(old_data->>'cashier_id',  '')::uuid,
     NULLIF(old_data->>'user_id',     '')::uuid
   )
 WHERE changed_by IS NULL;
