ALTER TABLE mf_instances ADD COLUMN host TEXT;
ALTER TABLE mf_instances ADD COLUMN backend_port INTEGER;
ALTER TABLE mf_instances ADD COLUMN frontend_port INTEGER;
ALTER TABLE mf_instances ADD COLUMN service_name TEXT;
ALTER TABLE mf_instances ADD COLUMN workspace_path TEXT;
ALTER TABLE mf_instances ADD COLUMN runtime_instance_id TEXT;
ALTER TABLE mf_instances ADD COLUMN template_version TEXT;
