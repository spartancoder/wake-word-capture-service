import { Toucan } from "toucan-js";
import { WorkerEvent } from "../common";
import { AGES, GENDERS, LEGACY_ACCENTS } from "../data/demographics";

enum TRIGGER_PATH {
  WAKE_WORD_TRAINING_UPLOAD = "/assist/wake_word/training_data/upload",
  WAKE_WORD_TRAINING_LIST = "/assist/wake_word/training_data/list",
  WAKE_WORD_TRAINING_DOWNLOAD = "/assist/wake_word/training_data/download",
}
const WAKE_WORD_ALLOWED_CONTENT_TYPES = [
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/wav",
];
const WAKE_WORD_ALLOWED_NAMES = ["hey_nexus"];
const NEGATIVE_WAKE_WORD_ALLOWED_NAMES = ["hey_lexus", "hey_texas", "texas"];
const WAKE_WORD_MAX_CONTENT_LENGTH = 250 * 1024;

const createResponse = (options: {
  content: Record<string, any> | string;
  status?: number;
}) =>
  new Response(JSON.stringify(options.content, null, 2), {
    status: options.status ?? 400,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "PUT",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json;charset=UTF-8",
    },
  });

const handleUploadAudioFile = async (event: WorkerEvent): Promise<Response> => {
  const { request } = event;
  const contentType = request.headers.get("content-type")?.split(";")[0];
  const contentLengthHeaderValue = request.headers.get("content-length");
  const contentLength =
    contentLengthHeaderValue && parseInt(contentLengthHeaderValue, 10);
  const cfRay = request.headers.get("cf-ray");

  const { searchParams } = new URL(request.url);
  const wakeWord = searchParams.get("wake_word");
  const age = searchParams.get("age") || "";
  const gender = searchParams.get("gender") || "do_not_wish_to_say";
  const language = searchParams.get("language");
  const accent = searchParams.get("accent");

  if (request.method !== "PUT") {
    return createResponse({
      content: { message: "Invalid method" },
      status: 405,
    });
  }

  if (!contentType || !WAKE_WORD_ALLOWED_CONTENT_TYPES.includes(contentType)) {
    return createResponse({
      content: {
        message: `Invalid content-type, received: ${contentType}, allowed: ${WAKE_WORD_ALLOWED_CONTENT_TYPES}`,
      },
      status: 415,
    });
  }
  if (!contentLength || contentLength > WAKE_WORD_MAX_CONTENT_LENGTH) {
    return createResponse({
      content: {
        message: `Invalid content-length, received: ${contentLength}, allowed [<${WAKE_WORD_MAX_CONTENT_LENGTH}]`,
      },
      status: 413,
    });
  }
  if (!wakeWord) {
    return createResponse({
      content: {
        message: `Invalid parameters: missing wake_word`,
      },
    });
  }

  if (
    ![...WAKE_WORD_ALLOWED_NAMES, ...NEGATIVE_WAKE_WORD_ALLOWED_NAMES].includes(
      wakeWord
    )
  ) {
    return createResponse({
      content: { message: `Invalid wake word, received: ${wakeWord}` },
    });
  }

  // Validate age (empty string is valid default in AGES)
  if (!(age in AGES)) {
    return createResponse({
      content: {
        message: `Invalid age, received: ${age}, allowed: ${Object.keys(AGES)
          .filter((k) => k !== "")
          .join(", ")}`,
      },
    });
  }

  // Gender validation (do_not_wish_to_say is a valid value in GENDERS, so no need to skip)
  if (!(gender in GENDERS)) {
    return createResponse({
      content: {
        message: `Invalid gender, received: ${gender}, allowed: ${Object.keys(
          GENDERS
        ).join(", ")}`,
      },
    });
  }

  // Validate language and accent combination
  let languageAccent: string | null = null;
  if (language || accent) {
    // Both language and accent must be provided together
    if (!language || !accent) {
      return createResponse({
        content: {
          message: "Both language and accent must be provided together",
        },
      });
    }

    // Validate language exists
    if (!(language in LEGACY_ACCENTS)) {
      return createResponse({
        content: {
          message: `Invalid language, received: ${language}, allowed: ${Object.keys(
            LEGACY_ACCENTS
          ).join(", ")}`,
        },
      });
    }

    // Validate accent exists for the given language
    if (!(accent in LEGACY_ACCENTS[language])) {
      return createResponse({
        content: {
          message: `Invalid accent for language ${language}, received: ${accent}, allowed: ${Object.keys(
            LEGACY_ACCENTS[language]
          ).join(", ")}`,
        },
      });
    }

    // Create combined language_accent value
    languageAccent = `${language}_${accent}`;
  }

  const isNegative = NEGATIVE_WAKE_WORD_ALLOWED_NAMES.includes(wakeWord);
  const keyExtension = contentType.replace("audio/", "");

  // Generate a unique identifier using timestamp and random string
  const timestamp = Date.now();
  const randomString = Math.random().toString(36).substring(2, 15);
  const uniqueId = `${timestamp}-${randomString}`;

  // Use cfRay if available, otherwise use uniqueId
  const identifier = cfRay || uniqueId;

  // Build filename in order: {wake_word}-{languageAccent}-{age}-{gender}-{identifier}
  const filenameParts = [
    isNegative ? "negative" : null,
    wakeWord,
    languageAccent || null,
    age || null,
    gender,
    identifier,
  ].filter((part) => part !== null && part !== "");

  const key = `${filenameParts.join("-")}.${keyExtension}`;

  console.log(key);

  await event.env.WAKEWORD_TRAINING_BUCKET.put(key, request.body);

  return createResponse({ content: { message: "success", key }, status: 201 });
};

const handleListFiles = async (event: WorkerEvent): Promise<Response> => {
  const { searchParams } = new URL(event.request.url);
  const limit = parseInt(searchParams.get("limit") || "1000", 10);
  const prefix = searchParams.get("prefix") || "";
  const cursor = searchParams.get("cursor") || undefined;

  try {
    const listed = await event.env.WAKEWORD_TRAINING_BUCKET.list({
      limit: Math.min(limit, 1000),
      prefix,
      cursor,
    });

    const objects = listed.objects.map((obj) => ({
      key: obj.key,
      size: obj.size,
      uploaded: obj.uploaded.toISOString(),
      httpMetadata: obj.httpMetadata,
    }));

    return new Response(
      JSON.stringify(
        {
          objects,
          truncated: listed.truncated,
          cursor: listed.cursor,
          delimitedPrefixes: listed.delimitedPrefixes,
        },
        null,
        2
      ),
      {
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET",
          "Access-Control-Allow-Headers": "Content-Type",
          "Content-Type": "application/json;charset=UTF-8",
        },
      }
    );
  } catch (error) {
    return createResponse({
      content: {
        message: "Error listing files",
        error: error instanceof Error ? error.message : String(error),
      },
      status: 500,
    });
  }
};

const handleDownloadFile = async (event: WorkerEvent): Promise<Response> => {
  const { searchParams } = new URL(event.request.url);
  const key = searchParams.get("key");

  if (!key) {
    return createResponse({
      content: { message: "Missing required parameter: key" },
      status: 400,
    });
  }

  try {
    const object = await event.env.WAKEWORD_TRAINING_BUCKET.get(key);

    if (!object) {
      return createResponse({
        content: { message: `File not found: ${key}` },
        status: 404,
      });
    }

    const headers = new Headers();
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Access-Control-Allow-Methods", "GET");
    headers.set("Access-Control-Allow-Headers", "Content-Type");

    if (object.httpMetadata?.contentType) {
      headers.set("Content-Type", object.httpMetadata.contentType);
    }

    headers.set("Content-Disposition", `attachment; filename="${key}"`);
    headers.set("Content-Length", object.size.toString());

    return new Response(object.body, {
      status: 200,
      headers,
    });
  } catch (error) {
    return createResponse({
      content: {
        message: "Error downloading file",
        error: error instanceof Error ? error.message : String(error),
      },
      status: 500,
    });
  }
};

export async function assistHandler(
  requestUrl: URL,
  event: WorkerEvent,
  _sentry: Toucan
): Promise<Response> {
  if (event.request.method === "OPTIONS") {
    // CORS preflight request
    return createResponse({ content: "ok", status: 200 });
  }
  switch (requestUrl.pathname) {
    case TRIGGER_PATH.WAKE_WORD_TRAINING_UPLOAD:
      return await handleUploadAudioFile(event);
    case TRIGGER_PATH.WAKE_WORD_TRAINING_LIST:
      return await handleListFiles(event);
    case TRIGGER_PATH.WAKE_WORD_TRAINING_DOWNLOAD:
      return await handleDownloadFile(event);
  }

  return createResponse({ content: "Not Found", status: 404 });
}
