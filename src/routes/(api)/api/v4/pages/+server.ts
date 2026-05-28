import { json, type RequestHandler } from "@sveltejs/kit";
import db from "$lib/server/db/db";
import type {
  GetPagesListResponse,
  PageResponse,
  CreatePageRequest,
  CreatePageResponse,
  BadRequestResponse,
  PageMonitorInput,
} from "$lib/types/api";
import type { PageRecord } from "$lib/server/types/db";
import GC from "$lib/global-constants";
import { toApiPageSettings, applyPageSettingsPatch, validatePageSettings } from "$lib/server/pageSettings";
import { normalizePageMonitorInputs } from "$lib/server/controllers/pagesController";

function formatDateToISO(date: Date | string): string {
  if (date instanceof Date) {
    return date.toISOString();
  }
  // Handle string dates (e.g., from SQLite: "2026-01-27 16:07:19")
  const parsed = new Date(date.replace(" ", "T") + "Z");
  return parsed.toISOString();
}

async function formatPageResponse(page: PageRecord): Promise<PageResponse> {
  const pageSettings = toApiPageSettings(page.page_settings_json);

  const pageMonitors = await db.getPageMonitors(page.id);

  return {
    id: page.id,
    // The home page's empty page_path renders as the addressable ~home token
    page_path: page.page_path === "" ? GC.HOME_PAGE_TOKEN : page.page_path,
    page_title: page.page_title,
    page_header: page.page_header,
    page_subheader: page.page_subheader,
    page_logo: page.page_logo,
    page_settings: pageSettings,
    monitors: pageMonitors.map((pm) => ({
      monitor_tag: pm.monitor_tag,
      position: pm.position,
      group: pm.group_name,
    })),
    created_at: formatDateToISO(page.created_at),
    updated_at: formatDateToISO(page.updated_at),
  };
}

export const GET: RequestHandler = async () => {
  const rawPages = await db.getAllPages();

  const pages: PageResponse[] = await Promise.all(rawPages.map(formatPageResponse));

  const response: GetPagesListResponse = {
    pages,
  };

  return json(response);
};

export const POST: RequestHandler = async ({ request }) => {
  let body: CreatePageRequest;

  try {
    body = await request.json();
  } catch {
    const errorResponse: BadRequestResponse = {
      error: {
        code: "BAD_REQUEST",
        message: "Invalid JSON body",
      },
    };
    return json(errorResponse, { status: 400 });
  }

  // Validate required fields
  if (!body.page_path || typeof body.page_path !== "string") {
    const errorResponse: BadRequestResponse = {
      error: {
        code: "BAD_REQUEST",
        message: "page_path is required and must be a string",
      },
    };
    return json(errorResponse, { status: 400 });
  }

  // Make page_path URL-friendly: lowercase, replace spaces with hyphens, remove special chars
  const sanitizedPagePath = body.page_path
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "");

  if (!body.page_title || typeof body.page_title !== "string" || body.page_title.trim().length === 0) {
    const errorResponse: BadRequestResponse = {
      error: {
        code: "BAD_REQUEST",
        message: "page_title is required and must be a non-empty string",
      },
    };
    return json(errorResponse, { status: 400 });
  }

  if (!body.page_header || typeof body.page_header !== "string" || body.page_header.trim().length === 0) {
    const errorResponse: BadRequestResponse = {
      error: {
        code: "BAD_REQUEST",
        message: "page_header is required and must be a non-empty string",
      },
    };
    return json(errorResponse, { status: 400 });
  }

  // Check if page with this path already exists
  const existingPage = await db.getPageByPath(sanitizedPagePath);
  if (existingPage) {
    const errorResponse: BadRequestResponse = {
      error: {
        code: "BAD_REQUEST",
        message: `Page with path '${sanitizedPagePath}' already exists`,
      },
    };
    return json(errorResponse, { status: 400 });
  }

  // Normalize monitors (accepts string[] or Array<{tag, group?, position?}>)
  let normalizedMonitors: ReturnType<typeof normalizePageMonitorInputs> = [];
  if (body.monitors && Array.isArray(body.monitors)) {
    try {
      normalizedMonitors = normalizePageMonitorInputs(body.monitors as PageMonitorInput[]);
    } catch (e) {
      return json({ error: { code: "BAD_REQUEST", message: (e as Error).message } } satisfies BadRequestResponse, {
        status: 400,
      });
    }
    for (const m of normalizedMonitors) {
      const monitor = await db.getMonitorByTag(m.tag);
      if (!monitor) {
        const errorResponse: BadRequestResponse = {
          error: {
            code: "BAD_REQUEST",
            message: `Monitor with tag '${m.tag}' does not exist`,
          },
        };
        return json(errorResponse, { status: 400 });
      }
    }
  }

  // Validate page settings if provided
  const settingsError = validatePageSettings(body.page_settings);
  if (settingsError) {
    const errorResponse: BadRequestResponse = {
      error: {
        code: "BAD_REQUEST",
        message: settingsError,
      },
    };
    return json(errorResponse, { status: 400 });
  }

  // Create the page
  const pageData = {
    page_path: sanitizedPagePath,
    page_title: body.page_title.trim(),
    page_header: body.page_header.trim(),
    page_subheader: body.page_subheader ?? null,
    page_logo: body.page_logo ?? null,
    page_settings_json: applyPageSettingsPatch(null, body.page_settings),
  };

  const createdPage = await db.createPage(pageData);

  // Add monitors to the page
  for (const m of normalizedMonitors) {
    await db.addMonitorToPage({
      page_id: createdPage.id,
      monitor_tag: m.tag,
      monitor_settings_json: null,
      position: m.position,
      group_name: m.group,
    });
  }

  const response: CreatePageResponse = {
    page: await formatPageResponse(createdPage),
  };

  return json(response, { status: 201 });
};
