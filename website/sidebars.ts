import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

// Mirrors the MkDocs nav structure exactly.
const sidebars: SidebarsConfig = {
  userGuide: [
    {
      type: "category",
      label: "User Guide",
      items: [
        { type: "doc", id: "user-guide/getting-started", label: "Getting Started" },
        { type: "doc", id: "user-guide/marketplace", label: "Marketplace" },
        { type: "doc", id: "user-guide/repository-installation", label: "Repository Installation" },
        { type: "doc", id: "user-guide/sources", label: "Sources" },
        { type: "doc", id: "user-guide/profiles-and-hubs", label: "Profiles and Hubs" },
        { type: "doc", id: "user-guide/configuration", label: "Configuration" },
        { type: "doc", id: "user-guide/troubleshooting", label: "Troubleshooting" },
      ],
    },
  ],
  authorGuide: [
    {
      type: "category",
      label: "Author Guide",
      items: [
        { type: "doc", id: "author-guide/creating-source-bundle", label: "Creating Collections" },
        { type: "doc", id: "author-guide/creating-skills", label: "Creating Skills" },
        { type: "doc", id: "author-guide/collection-scripts", label: "Collection Scripts" },
        { type: "doc", id: "author-guide/collection-schema", label: "Collection Schema" },
        { type: "doc", id: "author-guide/agentic-primitives-guide", label: "Agentic Primitives" },
        { type: "doc", id: "author-guide/adding-profile-source-to-hub", label: "Adding Sources to Hubs" },
        { type: "doc", id: "author-guide/validation", label: "Validation" },
        { type: "doc", id: "author-guide/publishing", label: "Publishing" },
      ],
    },
  ],
  contributorGuide: [
    {
      type: "category",
      label: "Contributor Guide",
      items: [
        { type: "doc", id: "contributor-guide/development-setup", label: "Development Setup" },
        { type: "doc", id: "contributor-guide/architecture", label: "Architecture" },
        {
          type: "category",
          label: "Architecture Details",
          items: [
            { type: "doc", id: "contributor-guide/architecture/adapters", label: "Adapters" },
            { type: "doc", id: "contributor-guide/architecture/authentication", label: "Authentication" },
            { type: "doc", id: "contributor-guide/architecture/installation-flow", label: "Installation Flow" },
            { type: "doc", id: "contributor-guide/architecture/update-system", label: "Update System" },
            { type: "doc", id: "contributor-guide/architecture/ui-components", label: "UI Components" },
            { type: "doc", id: "contributor-guide/architecture/mcp-integration", label: "MCP Integration" },
            { type: "doc", id: "contributor-guide/architecture/scaffolding", label: "Scaffolding" },
            { type: "doc", id: "contributor-guide/architecture/validation", label: "Validation" },
          ],
        },
        { type: "doc", id: "contributor-guide/core-flows", label: "Core Flows" },
        { type: "doc", id: "contributor-guide/testing", label: "Testing" },
        {
          type: "category",
          label: "Testing Details",
          items: [
            { type: "doc", id: "contributor-guide/testing/test-plan", label: "Manual Test Plan" },
            { type: "doc", id: "contributor-guide/testing/ssh-remote", label: "Testing SSH Remote" },
          ],
        },
        { type: "doc", id: "contributor-guide/validation", label: "Validation" },
        { type: "doc", id: "contributor-guide/coding-standards", label: "Coding Standards" },
        { type: "doc", id: "contributor-guide/spec-collection-scripts-lib", label: "Collection Scripts Spec" },
        { type: "doc", id: "contributor-guide/releasing", label: "Releasing" },
      ],
    },
  ],
  reference: [
    {
      type: "category",
      label: "Reference",
      items: [
        { type: "doc", id: "reference/commands", label: "Commands" },
        { type: "doc", id: "reference/settings", label: "Settings" },
        { type: "doc", id: "reference/adapter-api", label: "Adapter API" },
        { type: "doc", id: "reference/hub-schema", label: "Hub Schema" },
      ],
    },
  ],
};

export default sidebars;
