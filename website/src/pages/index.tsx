import React from "react";
import Layout from "@theme/Layout";
import MDXContent from "@theme/MDXContent";
import Readme from "@site/../docs/README.md";

export default function HomePage(): React.JSX.Element {
  return (
    <Layout title="Prompt Registry" description="Marketplace and registry for Copilot prompt bundles in VS Code">
      <main>
        <div className="container padding-top--md padding-bottom--lg">
          <article className="theme-doc-markdown markdown">
            <MDXContent>
              <Readme />
            </MDXContent>
          </article>
        </div>
      </main>
    </Layout>
  );
}