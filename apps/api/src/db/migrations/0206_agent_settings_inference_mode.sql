-- Spec 036: explicit per-agent inference destination ('local' | 'cloud'); NULL keeps existing behavior.
ALTER TABLE agent_settings ADD COLUMN inference_mode TEXT;
