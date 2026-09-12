"use client";

import { ProjectSettings } from '@/components/settings/ProjectSettings';

type ChatProjectSettingsProps = {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  projectName: string;
  projectDescription: string;
  onProjectUpdated: (update: { name: string; description?: string | null }) => void;
};

export function ChatProjectSettings({
  isOpen,
  onClose,
  projectId,
  projectName,
  projectDescription,
  onProjectUpdated,
}: ChatProjectSettingsProps) {
  return (
    <ProjectSettings
      isOpen={isOpen}
      onClose={onClose}
      projectId={projectId}
      projectName={projectName}
      projectDescription={projectDescription}
      initialTab="services"
      onProjectUpdated={onProjectUpdated}
    />
  );
}
