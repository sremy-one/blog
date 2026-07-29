import { getCollection } from "astro:content";
import { createMarkdownProcessor } from "@astrojs/markdown-remark";
import {
	dynamicSearchText,
	dynamicSlug,
	sortDynamics,
} from "@/utils/dynamic-utils";
import { url } from "@/utils/url-utils";

const markdownImagePattern = /!\[([^\]]*)\]\((\S+?)(?:\s+["']([^"']*)["'])?\)/g;
const absoluteUrlPattern = /^[a-z][a-z\d+.-]*:/i;

function resolveImageSrc(src: string, entryId: string): string {
	if (absoluteUrlPattern.test(src) || src.startsWith("//")) return src;
	if (src.startsWith("/")) return url(src);

	const entrySlug = dynamicSlug(entryId).replace(/\\/g, "/");
	const lastSlashIndex = entrySlug.lastIndexOf("/");
	const entryDirectory =
		lastSlashIndex >= 0 ? entrySlug.slice(0, lastSlashIndex + 1) : "";
	const resolved = new URL(
		src,
		`https://dynamic.local/dynamic/${entryDirectory}`,
	);

	return url(`${resolved.pathname}${resolved.search}${resolved.hash}`);
}

export async function GET(): Promise<Response> {
	const processor = await createMarkdownProcessor();
	const dynamics = sortDynamics(await getCollection("dynamic"));
	const data = await Promise.all(
		dynamics.map(async (entry) => {
			const images: Array<{ alt: string; src: string; title?: string }> = [];
			const markdown = (entry.body || "").replace(
				markdownImagePattern,
				(_match, alt: string, src: string, title?: string) => {
					images.push({
						alt,
						src: resolveImageSrc(src, entry.id),
						...(title ? { title } : {}),
					});
					return "";
				},
			);
			const rendered = await processor.render(markdown);

			return {
				id: dynamicSlug(entry.id),
				published: entry.data.published.getTime(),
				html: rendered.code,
				images,
				searchText: dynamicSearchText(entry),
				pinned: entry.data.pinned || false,
			};
		}),
	);

	return new Response(JSON.stringify(data), {
		headers: {
			"Content-Type": "application/json; charset=utf-8",
		},
	});
}
