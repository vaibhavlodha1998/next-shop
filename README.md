This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## AI PR reviewer

This repo has the AI PR reviewer installed in `.ai-review/` and `.github/`. Every pull request gets a first-pass review against the rules in `AGENTS.md`, using what the reviewer learned about the project in `.ai-review/project-context.md`.

First time after pushing to GitHub:

1. Settings > Actions > General > Workflow permissions: tick "Allow GitHub Actions to create and approve pull requests".
2. Actions > **ai-review-analyze** > Run workflow. It opens a PR with the project context and starter rules.
3. Read that PR, fix anything wrong, and merge it.
4. Open pull requests as usual. Drafts arrive in an issue; reply `/approve` to post them.

Details, commands and settings: [.ai-review/README.md](.ai-review/README.md).
