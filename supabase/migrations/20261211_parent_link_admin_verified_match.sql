-- Let administrators link a pending request to the active student record they
-- verified in official school records, even if parent-entered text differs.
-- The selected student ID is admin-only input, and the decision is audited.
CREATE OR REPLACE FUNCTION public.review_parent_link_request(
  p_request_id UUID,p_status TEXT,p_note TEXT,p_verified_student_id UUID
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_admin UUID:=public.current_profile_id();
  v_req public.parent_linking_requests%ROWTYPE;
  v_parent_profile UUID;
  v_parent_name TEXT;
  v_student UUID;
  v_student_name TEXT;
  v_student_number TEXT;
  v_student_grade TEXT;
  v_student_section TEXT;
  v_manual_match BOOLEAN:=FALSE;
BEGIN
  IF v_admin IS NULL OR NOT public.has_school_role('administrator') THEN
    RAISE EXCEPTION 'Administrator access required' USING ERRCODE='42501';
  END IF;
  IF p_status NOT IN ('APPROVED','REJECTED') THEN
    RAISE EXCEPTION 'Decision must be APPROVED or REJECTED' USING ERRCODE='22023';
  END IF;
  IF p_status='APPROVED' AND length(trim(COALESCE(p_note,'')))<4 THEN
    RAISE EXCEPTION 'Enter the official school record used to verify this relationship' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_req FROM public.parent_linking_requests
  WHERE id=p_request_id AND status='PENDING' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pending link request not found' USING ERRCODE='P0002'; END IF;

  SELECT pa.profile_id,pr.full_name INTO v_parent_profile,v_parent_name
  FROM public.parents pa JOIN public.profiles pr ON pr.id=pa.profile_id WHERE pa.id=v_req.parent_id;
  IF v_parent_profile IS NULL THEN RAISE EXCEPTION 'Parent account was not found' USING ERRCODE='P0002'; END IF;

  IF p_status='APPROVED' THEN
    IF NOT EXISTS(
      SELECT 1 FROM public.profiles pr JOIN auth.users u ON u.id=pr.auth_user_id
      WHERE pr.id=v_parent_profile AND pr.is_active AND u.email_confirmed_at IS NOT NULL
    ) THEN RAISE EXCEPTION 'Parent must verify their email before approval' USING ERRCODE='42501'; END IF;

    IF p_verified_student_id IS NOT NULL THEN
      v_manual_match:=TRUE;
      SELECT s.id,pr.full_name,s.student_id,s.grade_level,COALESCE(sec.name,'Unassigned')
      INTO v_student,v_student_name,v_student_number,v_student_grade,v_student_section
      FROM public.students s JOIN public.profiles pr ON pr.id=s.profile_id
      LEFT JOIN public.sections sec ON sec.id=s.section_id
      WHERE s.id=p_verified_student_id AND s.status='active' AND pr.is_active;
      IF v_student IS NULL THEN
        RAISE EXCEPTION 'The selected student record is inactive or does not exist' USING ERRCODE='22023';
      END IF;
    ELSE
      SELECT s.id,pr.full_name,s.student_id,s.grade_level,COALESCE(sec.name,'Unassigned')
      INTO v_student,v_student_name,v_student_number,v_student_grade,v_student_section
      FROM public.students s JOIN public.profiles pr ON pr.id=s.profile_id
      LEFT JOIN public.sections sec ON sec.id=s.section_id
      WHERE lower(trim(s.student_id))=lower(trim(v_req.student_number))
        AND lower(trim(pr.full_name))=lower(trim(v_req.submitted_student_name))
        AND lower(trim(s.grade_level))=lower(trim(v_req.submitted_grade_level))
        AND lower(trim(COALESCE(sec.name,'Unassigned')))=lower(trim(v_req.submitted_section_name))
        AND s.status='active' AND pr.is_active
        AND (v_req.linking_code IS NULL OR s.guardian_link_code=v_req.linking_code)
      LIMIT 1;
      IF v_student IS NULL THEN
        RAISE EXCEPTION 'No active student exactly matches the submitted details. Search for the student record verified in official school records and select it before approving.' USING ERRCODE='22023';
      END IF;
    END IF;

    INSERT INTO public.student_guardians(parent_id,student_id,is_authorized,relationship_type,verification_status,verified_by,verified_at)
    VALUES(v_req.parent_id,v_student,TRUE,v_req.relationship_type,'APPROVED',v_admin,NOW())
    ON CONFLICT(parent_id,student_id) DO UPDATE SET
      is_authorized=TRUE,relationship_type=EXCLUDED.relationship_type,
      verification_status='APPROVED',verified_by=v_admin,verified_at=NOW();
  END IF;

  UPDATE public.parent_linking_requests
  SET status=p_status,decision_note=NULLIF(trim(p_note),''),reviewed_by=v_admin,reviewed_at=NOW(),
      linked_student_id=v_student,updated_at=NOW()
  WHERE id=p_request_id;

  INSERT INTO public.audit_logs(actor_id,entity_type,entity_id,entity_label,action,module,description,new_values,status)
  VALUES(v_admin,'parent_linking_request',p_request_id,v_parent_name,'parent_link_'||lower(p_status),
    'parent_portal','Administrator reviewed a parent-student link request',
    jsonb_build_object('status',p_status,'verification_note',NULLIF(trim(p_note),''),
      'submitted_student_number',v_req.student_number,'linked_student_id',v_student,
      'linked_student_number',v_student_number,'linked_student_name',v_student_name,
      'manual_student_match',v_manual_match), 'success');

  INSERT INTO public.notifications(recipient_id,actor_id,type,payload)
  VALUES(v_parent_profile,v_admin,'parent_link_request_decision',jsonb_build_object(
    'request_id',p_request_id,'status',p_status,'student_name',v_student_name,
    'category','requests','title','Student link request update',
    'message','Your student-link request was '||lower(p_status)||'.',
    'decision_note',NULLIF(trim(p_note),'')));
  RETURN p_request_id;
END;
$$;
REVOKE ALL ON FUNCTION public.review_parent_link_request(UUID,TEXT,TEXT,UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.review_parent_link_request(UUID,TEXT,TEXT,UUID) TO authenticated;

-- Preserve the previous RPC signature for already-open clients.
CREATE OR REPLACE FUNCTION public.review_parent_link_request(p_request_id UUID,p_status TEXT,p_note TEXT DEFAULT NULL)
RETURNS UUID LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.review_parent_link_request(p_request_id,p_status,p_note,NULL::UUID);
$$;
REVOKE ALL ON FUNCTION public.review_parent_link_request(UUID,TEXT,TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.review_parent_link_request(UUID,TEXT,TEXT) TO authenticated;
