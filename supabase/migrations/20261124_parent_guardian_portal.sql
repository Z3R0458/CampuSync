-- Parent self-registration, verified student links, and configurable attendance notices.
ALTER TABLE public.parents
  ADD COLUMN IF NOT EXISTS contact_number TEXT,
  ADD COLUMN IF NOT EXISTS profile_photo_path TEXT;
ALTER TABLE public.students ADD COLUMN IF NOT EXISTS guardian_link_code TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS students_guardian_link_code_unique ON public.students(guardian_link_code) WHERE guardian_link_code IS NOT NULL;

ALTER TABLE public.student_guardians
  ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS relationship_type TEXT,
  ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'APPROVED',
  ADD COLUMN IF NOT EXISTS verified_by UUID REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
UPDATE public.student_guardians SET verification_status='APPROVED', verified_at=COALESCE(verified_at,NOW()) WHERE is_authorized AND verification_status<>'APPROVED';
UPDATE public.student_guardians SET verification_status='REVOKED' WHERE NOT is_authorized AND verification_status='APPROVED';
ALTER TABLE public.student_guardians DROP CONSTRAINT IF EXISTS student_guardians_verification_status_check;
ALTER TABLE public.student_guardians ADD CONSTRAINT student_guardians_verification_status_check CHECK(verification_status IN ('PENDING','APPROVED','REJECTED','REVOKED'));
CREATE UNIQUE INDEX IF NOT EXISTS student_guardians_parent_student_unique ON public.student_guardians(parent_id,student_id);
CREATE UNIQUE INDEX IF NOT EXISTS student_guardians_id_unique ON public.student_guardians(id);
CREATE UNIQUE INDEX IF NOT EXISTS parents_profile_unique ON public.parents(profile_id);

CREATE TABLE IF NOT EXISTS public.parent_linking_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id UUID NOT NULL REFERENCES public.parents(id) ON DELETE CASCADE,
  student_number TEXT NOT NULL,
  submitted_student_name TEXT NOT NULL,
  submitted_grade_level TEXT NOT NULL,
  submitted_section_name TEXT NOT NULL,
  linking_code TEXT,
  relationship_type TEXT NOT NULL CHECK(relationship_type IN ('Mother','Father','Legal Guardian','Other')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED','REVOKED')),
  decision_note TEXT,
  reviewed_by UUID REFERENCES public.profiles(id),
  reviewed_at TIMESTAMPTZ,
  linked_student_id UUID REFERENCES public.students(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS parent_linking_requests_status_created_idx ON public.parent_linking_requests(status,created_at DESC);
CREATE INDEX IF NOT EXISTS parent_linking_requests_parent_created_idx ON public.parent_linking_requests(parent_id,created_at DESC);

CREATE TABLE IF NOT EXISTS public.parent_notification_preferences (
  parent_id UUID PRIMARY KEY REFERENCES public.parents(id) ON DELETE CASCADE,
  entry_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  exit_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  temporary_exit_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  return_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  early_out_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  visitor_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  announcement_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  email_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS public.parent_notification_delivery_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID NOT NULL REFERENCES public.notifications(id) ON DELETE CASCADE,
  recipient_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK(channel IN ('web_push','email')),
  delivery_key TEXT NOT NULL DEFAULT 'account',
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','SENT','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sent_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(notification_id,recipient_id,channel,delivery_key)
);
ALTER TABLE public.parent_notification_delivery_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.parent_notification_delivery_attempts FROM PUBLIC,anon,authenticated;

ALTER TABLE public.parent_linking_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.parent_notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.parents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_guardians ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE p RECORD; BEGIN
 FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='parents' LOOP EXECUTE format('DROP POLICY %I ON public.parents',p.policyname); END LOOP;
END $$;
CREATE POLICY parents_read_self_or_admin ON public.parents FOR SELECT TO authenticated USING(profile_id=public.current_profile_id() OR public.has_school_role('administrator'));
DROP POLICY IF EXISTS parent_link_requests_read_self ON public.parent_linking_requests;
CREATE POLICY parent_link_requests_read_self ON public.parent_linking_requests FOR SELECT TO authenticated
  USING (parent_id IN (SELECT p.id FROM public.parents p WHERE p.profile_id=public.current_profile_id()) OR public.has_school_role('administrator'));
DROP POLICY IF EXISTS parent_link_requests_insert_self ON public.parent_linking_requests;
CREATE POLICY parent_link_requests_insert_self ON public.parent_linking_requests FOR INSERT TO authenticated WITH CHECK(false);
DROP POLICY IF EXISTS parent_preferences_read_self ON public.parent_notification_preferences;
CREATE POLICY parent_preferences_read_self ON public.parent_notification_preferences FOR SELECT TO authenticated
  USING (parent_id IN (SELECT p.id FROM public.parents p WHERE p.profile_id=public.current_profile_id()));
DROP POLICY IF EXISTS parent_preferences_write_self ON public.parent_notification_preferences;
CREATE POLICY parent_preferences_write_self ON public.parent_notification_preferences FOR INSERT TO authenticated
  WITH CHECK(parent_id IN (SELECT p.id FROM public.parents p WHERE p.profile_id=public.current_profile_id()));
DROP POLICY IF EXISTS parent_preferences_update_self ON public.parent_notification_preferences;
CREATE POLICY parent_preferences_update_self ON public.parent_notification_preferences FOR UPDATE TO authenticated
  USING (parent_id IN (SELECT p.id FROM public.parents p WHERE p.profile_id=public.current_profile_id()))
  WITH CHECK(parent_id IN (SELECT p.id FROM public.parents p WHERE p.profile_id=public.current_profile_id()));
DROP POLICY IF EXISTS student_guardians_parent_read_approved ON public.student_guardians;
CREATE POLICY student_guardians_parent_read_approved ON public.student_guardians FOR SELECT TO authenticated
  USING ((is_authorized AND verification_status='APPROVED' AND parent_id IN (SELECT p.id FROM public.parents p WHERE p.profile_id=public.current_profile_id())) OR public.has_school_role('administrator'));
REVOKE INSERT,UPDATE,DELETE ON public.parent_linking_requests,public.parent_notification_preferences,public.student_guardians FROM authenticated;
GRANT SELECT ON public.parent_linking_requests,public.parent_notification_preferences,public.student_guardians TO authenticated;
GRANT INSERT,UPDATE ON public.parent_notification_preferences TO authenticated;

CREATE OR REPLACE FUNCTION public.parent_email_is_verified()
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS(SELECT 1 FROM auth.users u WHERE u.id=auth.uid() AND u.email_confirmed_at IS NOT NULL)
$$;
REVOKE ALL ON FUNCTION public.parent_email_is_verified() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.parent_email_is_verified() TO authenticated;

-- Authenticated self-registration can only provision a parent profile. It never creates a child link.
CREATE OR REPLACE FUNCTION public.provision_parent_signup()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_profile UUID;
BEGIN
  IF NEW.raw_user_meta_data->>'parent_self_registration' IS DISTINCT FROM 'true' THEN RETURN NEW; END IF;
  INSERT INTO public.profiles(auth_user_id,full_name,email,phone,role)
    VALUES(NEW.id,trim(COALESCE(NEW.raw_user_meta_data->>'full_name','')),lower(NEW.email),NULLIF(trim(NEW.raw_user_meta_data->>'phone'),''),'parent')
    ON CONFLICT(auth_user_id) DO UPDATE SET full_name=EXCLUDED.full_name,email=EXCLUDED.email,phone=EXCLUDED.phone
    RETURNING id INTO v_profile;
  INSERT INTO public.parents(profile_id,relationship,contact_number)
    VALUES(v_profile,NEW.raw_user_meta_data->>'relationship',NULLIF(trim(NEW.raw_user_meta_data->>'phone'),''))
    ON CONFLICT(profile_id) DO NOTHING;
  RETURN NEW;
END;$$;
REVOKE ALL ON FUNCTION public.provision_parent_signup() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS provision_parent_signup ON auth.users;
CREATE TRIGGER provision_parent_signup AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.provision_parent_signup();

CREATE OR REPLACE FUNCTION public.submit_parent_link_request(
  p_student_number TEXT,p_student_name TEXT,p_grade_level TEXT,p_section_name TEXT,p_relationship TEXT,p_linking_code TEXT DEFAULT NULL
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_profile UUID:=public.current_profile_id();v_parent UUID;v_id UUID;
BEGIN
  IF v_profile IS NULL OR NOT public.has_school_role('parent') OR NOT public.parent_email_is_verified() THEN RAISE EXCEPTION 'Verified parent account required' USING ERRCODE='42501';END IF;
  SELECT id INTO v_parent FROM public.parents WHERE profile_id=v_profile;
  IF v_parent IS NULL THEN RAISE EXCEPTION 'Parent profile not found';END IF;
  IF length(trim(COALESCE(p_student_number,'')))<2 OR length(trim(COALESCE(p_student_name,'')))<2 OR length(trim(COALESCE(p_grade_level,'')))<1 OR length(trim(COALESCE(p_section_name,'')))<1 OR p_relationship NOT IN ('Mother','Father','Legal Guardian','Other') THEN RAISE EXCEPTION 'Complete student ID, full name, grade, section, and relationship';END IF;
  IF EXISTS(SELECT 1 FROM public.student_guardians sg JOIN public.students s ON s.id=sg.student_id WHERE sg.parent_id=v_parent AND s.student_id=trim(p_student_number) AND sg.is_authorized AND sg.verification_status='APPROVED') THEN RAISE EXCEPTION 'This child is already linked to your account';END IF;
  IF EXISTS(SELECT 1 FROM public.parent_linking_requests WHERE parent_id=v_parent AND student_number=trim(p_student_number) AND status='PENDING') THEN RAISE EXCEPTION 'A linking request for this student is already pending';END IF;
  INSERT INTO public.parent_linking_requests(parent_id,student_number,submitted_student_name,submitted_grade_level,submitted_section_name,linking_code,relationship_type)
  VALUES(v_parent,trim(p_student_number),trim(p_student_name),trim(p_grade_level),trim(p_section_name),NULLIF(trim(p_linking_code),''),p_relationship) RETURNING id INTO v_id;
  INSERT INTO public.audit_logs(actor_id,entity_type,entity_id,action,module,description,new_values,status)
  VALUES(v_profile,'parent_linking_request',v_id,'parent_link_submitted','parent_portal','Parent submitted a student-link verification request',jsonb_build_object('student_number',trim(p_student_number),'relationship',p_relationship),'success');
  INSERT INTO public.notifications(recipient_id,actor_id,type,payload)
  SELECT id,v_profile,'parent_link_request_pending',jsonb_build_object('request_id',v_id,'parent_name',(SELECT full_name FROM public.profiles WHERE id=v_profile),'student_number',trim(p_student_number),'message','A parent or guardian requested a student account link.') FROM public.profiles WHERE role='administrator' AND is_active;
  RETURN v_id;
END;$$;
REVOKE ALL ON FUNCTION public.submit_parent_link_request(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.submit_parent_link_request(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.review_parent_link_request(p_request_id UUID,p_status TEXT,p_note TEXT DEFAULT NULL)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_admin UUID:=public.current_profile_id();v_req public.parent_linking_requests%ROWTYPE;v_parent_profile UUID;v_parent_name TEXT;v_student UUID;v_student_name TEXT;v_relationship UUID;
BEGIN
  IF v_admin IS NULL OR NOT public.has_school_role('administrator') THEN RAISE EXCEPTION 'Administrator access required' USING ERRCODE='42501';END IF;
  IF p_status NOT IN ('APPROVED','REJECTED') THEN RAISE EXCEPTION 'Decision must be APPROVED or REJECTED';END IF;
  IF p_status='APPROVED' AND length(trim(COALESCE(p_note,'')))<4 THEN RAISE EXCEPTION 'Record the official school record used to verify this relationship' USING ERRCODE='22023';END IF;
  SELECT * INTO v_req FROM public.parent_linking_requests WHERE id=p_request_id AND status='PENDING' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pending link request not found' USING ERRCODE='P0002';END IF;
  SELECT p.profile_id,pr.full_name INTO v_parent_profile,v_parent_name FROM public.parents p JOIN public.profiles pr ON pr.id=p.profile_id WHERE p.id=v_req.parent_id;
  IF p_status='APPROVED' THEN
    IF NOT EXISTS(SELECT 1 FROM public.profiles p JOIN auth.users u ON u.id=p.auth_user_id WHERE p.id=v_parent_profile AND u.email_confirmed_at IS NOT NULL) THEN RAISE EXCEPTION 'Parent must verify their email before approval' USING ERRCODE='42501';END IF;
    SELECT s.id,pr.full_name INTO v_student,v_student_name FROM public.students s JOIN public.profiles pr ON pr.id=s.profile_id
    JOIN public.sections sec ON sec.id=s.section_id
    WHERE s.student_id=v_req.student_number AND lower(trim(pr.full_name))=lower(trim(v_req.submitted_student_name))
      AND s.grade_level=v_req.submitted_grade_level AND sec.name=v_req.submitted_section_name AND s.status='active' AND pr.is_active
      AND (v_req.linking_code IS NULL OR s.guardian_link_code=v_req.linking_code);
    IF v_student IS NULL THEN RAISE EXCEPTION 'Student record does not match all submitted identifiers. Verify the school record before approving.' USING ERRCODE='22023';END IF;
    INSERT INTO public.student_guardians(parent_id,student_id,is_authorized,relationship_type,verification_status,verified_by,verified_at)
      VALUES(v_req.parent_id,v_student,TRUE,v_req.relationship_type,'APPROVED',v_admin,NOW())
      ON CONFLICT(parent_id,student_id) DO UPDATE SET is_authorized=TRUE,relationship_type=EXCLUDED.relationship_type,verification_status='APPROVED',verified_by=v_admin,verified_at=NOW();
  END IF;
  UPDATE public.parent_linking_requests SET status=p_status,decision_note=NULLIF(trim(p_note),''),reviewed_by=v_admin,reviewed_at=NOW(),linked_student_id=v_student,updated_at=NOW() WHERE id=p_request_id;
  INSERT INTO public.audit_logs(actor_id,entity_type,entity_id,entity_label,action,module,description,new_values,status)
  VALUES(v_admin,'parent_linking_request',p_request_id,v_parent_name,'parent_link_'||lower(p_status),'parent_portal','Administrator reviewed a parent-student link request',jsonb_build_object('status',p_status,'note',p_note,'student_id',v_student),'success');
  INSERT INTO public.notifications(recipient_id,actor_id,type,payload)
  VALUES(v_parent_profile,v_admin,'parent_link_request_decision',jsonb_build_object('request_id',p_request_id,'status',p_status,'student_name',v_student_name,'category','requests','title','Student link request update','message','Your student-link request was '||lower(p_status)||'.','decision_note',p_note));
  RETURN p_request_id;
END;$$;
REVOKE ALL ON FUNCTION public.review_parent_link_request(UUID,TEXT,TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.review_parent_link_request(UUID,TEXT,TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.revoke_parent_student_link(p_relationship_id UUID,p_note TEXT DEFAULT NULL)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_admin UUID:=public.current_profile_id();v_student UUID;v_parent UUID;v_name TEXT;
BEGIN
 IF v_admin IS NULL OR NOT public.has_school_role('administrator') THEN RAISE EXCEPTION 'Administrator access required' USING ERRCODE='42501';END IF;
 UPDATE public.student_guardians SET is_authorized=FALSE,verification_status='REVOKED',verified_by=v_admin,verified_at=NOW()
 WHERE id=p_relationship_id RETURNING student_id,parent_id INTO v_student,v_parent;
 IF NOT FOUND THEN RAISE EXCEPTION 'Parent-student relationship not found' USING ERRCODE='P0002';END IF;
 SELECT full_name INTO v_name FROM public.profiles WHERE id=(SELECT profile_id FROM public.parents WHERE id=v_parent);
 INSERT INTO public.parent_linking_requests(parent_id,student_number,submitted_student_name,submitted_grade_level,submitted_section_name,relationship_type,status,decision_note,reviewed_by,reviewed_at,linked_student_id)
 SELECT v_parent,s.student_id,p.full_name,s.grade_level,COALESCE(sec.name,'Unassigned'),COALESCE(sg.relationship_type,'Other'),'REVOKED',NULLIF(trim(p_note),''),v_admin,NOW(),s.id FROM public.students s JOIN public.profiles p ON p.id=s.profile_id LEFT JOIN public.sections sec ON sec.id=s.section_id JOIN public.student_guardians sg ON sg.id=p_relationship_id WHERE s.id=v_student;
 INSERT INTO public.audit_logs(actor_id,entity_type,entity_id,entity_label,action,module,description,new_values,status)
 VALUES(v_admin,'student_guardian',p_relationship_id,v_name,'parent_link_revoked','parent_portal','Administrator revoked a parent-student relationship',jsonb_build_object('student_id',v_student,'note',p_note),'success');
 RETURN p_relationship_id;
END;$$;
REVOKE ALL ON FUNCTION public.revoke_parent_student_link(UUID,TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.revoke_parent_student_link(UUID,TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.save_parent_notification_preferences(
 p_entry BOOLEAN,p_exit BOOLEAN,p_temporary_exit BOOLEAN,p_return BOOLEAN,p_early_out BOOLEAN,p_visitor BOOLEAN,p_announcement BOOLEAN,p_email BOOLEAN
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_parent UUID;
BEGIN
 IF NOT public.has_school_role('parent') OR NOT public.parent_email_is_verified() THEN RAISE EXCEPTION 'Verified parent account required' USING ERRCODE='42501';END IF;
 SELECT id INTO v_parent FROM public.parents WHERE profile_id=public.current_profile_id();
 IF v_parent IS NULL THEN RAISE EXCEPTION 'Parent profile not found';END IF;
 INSERT INTO public.parent_notification_preferences(parent_id,entry_enabled,exit_enabled,temporary_exit_enabled,return_enabled,early_out_enabled,visitor_enabled,announcement_enabled,email_enabled,updated_at)
 VALUES(v_parent,TRUE,TRUE,p_temporary_exit,p_return,p_early_out,p_visitor,p_announcement,p_email,NOW()) ON CONFLICT(parent_id) DO UPDATE SET
 entry_enabled=TRUE,exit_enabled=TRUE,temporary_exit_enabled=EXCLUDED.temporary_exit_enabled,return_enabled=EXCLUDED.return_enabled,
 early_out_enabled=EXCLUDED.early_out_enabled,visitor_enabled=EXCLUDED.visitor_enabled,announcement_enabled=EXCLUDED.announcement_enabled,email_enabled=EXCLUDED.email_enabled,updated_at=NOW();
END;$$;
REVOKE ALL ON FUNCTION public.save_parent_notification_preferences(BOOLEAN,BOOLEAN,BOOLEAN,BOOLEAN,BOOLEAN,BOOLEAN,BOOLEAN,BOOLEAN) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.save_parent_notification_preferences(BOOLEAN,BOOLEAN,BOOLEAN,BOOLEAN,BOOLEAN,BOOLEAN,BOOLEAN,BOOLEAN) TO authenticated;

CREATE OR REPLACE FUNCTION public.prepare_parent_attendance_notification()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_event UUID;v_student UUID;v_event_type TEXT;v_name TEXT;v_school TEXT:='Valencia National High School';v_allowed BOOLEAN:=FALSE;v_time TIMESTAMPTZ;v_title TEXT;v_message TEXT;
BEGIN
 IF NEW.type NOT IN ('attendance_entry','attendance_exit','attendance_temporary_exit','attendance_return') THEN RETURN NEW;END IF;
 v_event:=NULLIF(NEW.payload->>'event_id','')::UUID;v_event_type:=upper(NEW.payload->>'event_type');v_time:=NULLIF(NEW.payload->>'actual_scan_time','')::TIMESTAMPTZ;
 SELECT e.person_id,p.full_name INTO v_student,v_name FROM public.attendance_events e JOIN public.students s ON s.id=e.person_id JOIN public.profiles p ON p.id=s.profile_id
 WHERE e.id=v_event AND e.person_type='student' AND e.event_type=v_event_type AND e.sync_status='SYNCED' AND e.verification_result IN ('VERIFIED','MANUAL_VERIFIED');
 IF v_student IS NULL OR v_time IS NULL OR NOT EXISTS(SELECT 1 FROM public.student_guardians sg JOIN public.parents pa ON pa.id=sg.parent_id JOIN public.profiles pp ON pp.id=pa.profile_id JOIN auth.users u ON u.id=pp.auth_user_id WHERE sg.student_id=v_student AND pa.profile_id=NEW.recipient_id AND sg.is_authorized AND sg.verification_status='APPROVED' AND pp.is_active AND u.email_confirmed_at IS NOT NULL) THEN RETURN NULL;END IF;
 SELECT CASE v_event_type WHEN 'ENTRY' THEN TRUE WHEN 'EXIT' THEN TRUE WHEN 'TEMPORARY_EXIT' THEN COALESCE(pref.temporary_exit_enabled,FALSE) WHEN 'RETURN' THEN COALESCE(pref.return_enabled,FALSE) ELSE FALSE END
 INTO v_allowed FROM public.parents pa LEFT JOIN public.parent_notification_preferences pref ON pref.parent_id=pa.id WHERE pa.profile_id=NEW.recipient_id;
 IF NOT COALESCE(v_allowed,FALSE) THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM public.notifications n WHERE n.recipient_id=NEW.recipient_id AND n.type=NEW.type AND n.payload->>'event_id'=v_event::text) THEN RETURN NULL;END IF;
 v_title:=CASE v_event_type WHEN 'ENTRY' THEN 'Your child has arrived at school.' WHEN 'EXIT' THEN 'Your child has left the school.' WHEN 'TEMPORARY_EXIT' THEN 'Your child has temporarily left school.' ELSE 'Your child has returned to school.' END;
 v_message:=v_name||CASE v_event_type WHEN 'ENTRY' THEN ' successfully entered' WHEN 'EXIT' THEN ' successfully exited' WHEN 'TEMPORARY_EXIT' THEN ' recorded a temporary exit' ELSE ' returned' END||' the school premises at '||to_char(v_time AT TIME ZONE 'Asia/Manila','FMHH12:MI AM')||' on '||to_char(v_time AT TIME ZONE 'Asia/Manila','Mon DD, YYYY')||'.';
 NEW.payload:=NEW.payload||jsonb_build_object('title',v_title,'message',v_message,'category','attendance','student_name',v_name,'student_id',(SELECT student_id FROM public.students WHERE id=v_student),'school_name',v_school,'actual_scan_time',v_time,'event_id',v_event);
 RETURN NEW;
END;$$;
REVOKE ALL ON FUNCTION public.prepare_parent_attendance_notification() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS parent_attendance_notification_filter ON public.notifications;
CREATE TRIGGER parent_attendance_notification_filter BEFORE INSERT ON public.notifications FOR EACH ROW EXECUTE FUNCTION public.prepare_parent_attendance_notification();
CREATE OR REPLACE FUNCTION public.notify_parent_request_update()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_parent RECORD;v_student_name TEXT;v_enabled BOOLEAN;v_type TEXT:=TG_ARGV[0];v_event_name TEXT;v_status TEXT:=to_jsonb(NEW)->>'status';v_old TEXT;
BEGIN
 IF TG_OP='UPDATE' THEN v_old:=to_jsonb(OLD)->>'status';IF v_old IS NOT DISTINCT FROM v_status THEN RETURN NEW;END IF;END IF;
 SELECT p.full_name INTO v_student_name FROM public.students s JOIN public.profiles p ON p.id=s.profile_id WHERE s.id=(to_jsonb(NEW)->>'student_id')::UUID;
 v_event_name:=CASE v_type WHEN 'early_out' THEN 'early-out request' ELSE 'visitor request' END;
 FOR v_parent IN SELECT pa.id AS parent_id,pa.profile_id FROM public.student_guardians sg JOIN public.parents pa ON pa.id=sg.parent_id JOIN public.profiles pr ON pr.id=pa.profile_id JOIN auth.users u ON u.id=pr.auth_user_id WHERE sg.student_id=(to_jsonb(NEW)->>'student_id')::UUID AND sg.is_authorized AND sg.verification_status='APPROVED' AND pr.is_active AND u.email_confirmed_at IS NOT NULL LOOP
   SELECT CASE WHEN v_type='early_out' THEN COALESCE(pref.early_out_enabled,TRUE) ELSE COALESCE(pref.visitor_enabled,TRUE) END INTO v_enabled FROM public.parent_notification_preferences pref WHERE pref.parent_id=v_parent.parent_id;
   IF COALESCE(v_enabled,TRUE) THEN
     INSERT INTO public.notifications(recipient_id,actor_id,type,payload)
     SELECT v_parent.profile_id,public.current_profile_id(),'parent_'||v_type||'_'||lower(v_status),jsonb_build_object('request_id',(to_jsonb(NEW)->>'id'),'student_name',v_student_name,'status',v_status,'category','requests','title',initcap(v_event_name)||' update','message','Update: your child’s '||v_event_name||' is now '||lower(v_status)||'.')
     WHERE NOT EXISTS(SELECT 1 FROM public.notifications n WHERE n.recipient_id=v_parent.profile_id AND n.type='parent_'||v_type||'_'||lower(v_status) AND n.payload->>'request_id'=to_jsonb(NEW)->>'id');
   END IF;
 END LOOP;
 RETURN NEW;
END;$$;
REVOKE ALL ON FUNCTION public.notify_parent_request_update() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS parent_early_out_notification ON public.early_out_requests;
CREATE TRIGGER parent_early_out_notification AFTER INSERT OR UPDATE OF status ON public.early_out_requests FOR EACH ROW EXECUTE FUNCTION public.notify_parent_request_update('early_out');
DROP TRIGGER IF EXISTS parent_visitor_request_notification ON public.visitor_requests;
CREATE TRIGGER parent_visitor_request_notification AFTER INSERT OR UPDATE OF status ON public.visitor_requests FOR EACH ROW EXECUTE FUNCTION public.notify_parent_request_update('visitor');

-- A parent only sees approved linked children; email confirmation is checked in every helper path.
CREATE OR REPLACE FUNCTION public.parent_can_access_student(p_student UUID)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT public.parent_email_is_verified() AND EXISTS(SELECT 1 FROM public.student_guardians sg JOIN public.parents pa ON pa.id=sg.parent_id WHERE pa.profile_id=public.current_profile_id() AND sg.student_id=p_student AND sg.is_authorized AND sg.verification_status='APPROVED')
$$;
REVOKE ALL ON FUNCTION public.parent_can_access_student(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.parent_can_access_student(UUID) TO authenticated;

DROP POLICY IF EXISTS students_read_linked_guardians ON public.students;
CREATE POLICY students_read_linked_guardians ON public.students FOR SELECT TO authenticated USING(public.parent_can_access_student(id));
DROP POLICY IF EXISTS attendance_read_authorized ON public.attendance_events;
CREATE POLICY attendance_read_authorized ON public.attendance_events FOR SELECT TO authenticated USING(
 public.has_school_role('administrator') OR public.has_school_role('guard') OR
 (person_type='student' AND (person_id IN(SELECT s.id FROM public.students s WHERE s.profile_id=public.current_profile_id()) OR (public.has_school_role('parent') AND public.parent_can_access_student(person_id)))) OR
 (person_type='teacher' AND person_id IN(SELECT t.id FROM public.teachers t WHERE t.profile_id=public.current_profile_id())));
DROP POLICY IF EXISTS attendance_summary_read_authorized ON public.attendance_daily_summaries;
CREATE POLICY attendance_summary_read_authorized ON public.attendance_daily_summaries FOR SELECT TO authenticated USING(
 public.has_school_role('administrator') OR public.has_school_role('guard') OR student_id IN(SELECT s.id FROM public.students s WHERE s.profile_id=public.current_profile_id()) OR (public.has_school_role('parent') AND public.parent_can_access_student(student_id)));
DROP POLICY IF EXISTS early_out_read_authorized ON public.early_out_requests;
CREATE POLICY early_out_read_authorized ON public.early_out_requests FOR SELECT TO authenticated USING(
 public.has_school_role('administrator') OR student_id IN(SELECT s.id FROM public.students s WHERE s.profile_id=public.current_profile_id()) OR (public.has_school_role('parent') AND public.parent_can_access_student(student_id)));
DROP POLICY IF EXISTS early_out_review_staff_admin ON public.early_out_requests;
DROP POLICY IF EXISTS early_out_review_admin ON public.early_out_requests;
CREATE POLICY early_out_review_admin ON public.early_out_requests FOR UPDATE TO authenticated USING(public.has_school_role('administrator')) WITH CHECK(public.has_school_role('administrator'));
DROP POLICY IF EXISTS visitor_request_read_authorized ON public.visitor_requests;
CREATE POLICY visitor_request_read_authorized ON public.visitor_requests FOR SELECT TO authenticated USING(
 public.has_school_role('administrator') OR student_id IN(SELECT s.id FROM public.students s WHERE s.profile_id=public.current_profile_id()) OR (public.has_school_role('parent') AND public.parent_can_access_student(student_id)));
DROP POLICY IF EXISTS visitor_request_review_staff_admin ON public.visitor_requests;
DROP POLICY IF EXISTS visitor_request_review_admin ON public.visitor_requests;
CREATE POLICY visitor_request_review_admin ON public.visitor_requests FOR UPDATE TO authenticated USING(public.has_school_role('administrator')) WITH CHECK(public.has_school_role('administrator'));
DROP POLICY IF EXISTS student_private_details_self_or_admin ON public.student_private_details;
CREATE POLICY student_private_details_self_or_admin ON public.student_private_details FOR SELECT TO authenticated USING(
 public.has_school_role('administrator') OR student_id IN(SELECT s.id FROM public.students s WHERE s.profile_id=public.current_profile_id()) OR (public.has_school_role('parent') AND public.parent_can_access_student(student_id)));

-- Revoke broad student_guardians access if another permissive policy exists, then re-add narrow admin/parent visibility.
DO $$ DECLARE p RECORD; BEGIN
 FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='student_guardians' LOOP EXECUTE format('DROP POLICY %I ON public.student_guardians',p.policyname); END LOOP;
END $$;
CREATE POLICY student_guardians_read_admin_or_parent ON public.student_guardians FOR SELECT TO authenticated USING(
 public.has_school_role('administrator') OR (parent_id IN(SELECT id FROM public.parents WHERE profile_id=public.current_profile_id()) AND verification_status='APPROVED' AND is_authorized));

-- Activate notification preferences for the guardian recipient when processing existing attendance RPC inserts.
COMMENT ON TABLE public.parent_linking_requests IS 'Parent-submitted, administrator-reviewed requests to link an existing enrolled student. No student access is granted while pending.';

CREATE OR REPLACE FUNCTION public.notify_parents_announcement()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 IF NEW.status='published' AND NEW.audience IN ('all','parent') AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
   INSERT INTO public.notifications(recipient_id,actor_id,type,payload)
   SELECT pa.profile_id,NEW.created_by,'parent_announcement_published',jsonb_build_object('announcement_id',NEW.id,'title',NEW.title,'message',NEW.title,'category','announcements')
   FROM public.parents pa JOIN public.profiles p ON p.id=pa.profile_id JOIN auth.users u ON u.id=p.auth_user_id
   LEFT JOIN public.parent_notification_preferences pref ON pref.parent_id=pa.id
   WHERE p.is_active AND u.email_confirmed_at IS NOT NULL AND COALESCE(pref.announcement_enabled,TRUE)
   AND NOT EXISTS(SELECT 1 FROM public.notifications n WHERE n.recipient_id=pa.profile_id AND n.type='parent_announcement_published' AND n.payload->>'announcement_id'=NEW.id::text);
 END IF;RETURN NEW;
END;$$;
REVOKE ALL ON FUNCTION public.notify_parents_announcement() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS announcement_parent_notification ON public.announcements;
CREATE TRIGGER announcement_parent_notification AFTER INSERT OR UPDATE OF status ON public.announcements FOR EACH ROW EXECUTE FUNCTION public.notify_parents_announcement();

DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') THEN
   IF NOT EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='parent_linking_requests') THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.parent_linking_requests;END IF;
   IF NOT EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='student_guardians') THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.student_guardians;END IF;
 END IF;
END $$;
