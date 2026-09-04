import { AppEnv } from "../../config/env";
import dotenv from "dotenv";
import { ShopifyGraphQLError, ShopifyGraphQLResponse } from "../../types/shopify";

export class ShopifyHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly responseBody: string,
    public readonly requestUrl: string
  ) {
    super(`Shopify HTTP error ${status} ${statusText} for ${requestUrl}`);
    this.name = "ShopifyHttpError";
  }
}

export class ShopifyGraphqlError extends Error {
  constructor(public readonly errors: ShopifyGraphQLError[]) {
    super(
      `Shopify GraphQL error: ${errors.map((error) => error.message).join("; ")}`
    );
    this.name = "ShopifyGraphqlError";
  }
}

export class ShopifyClient {
  private readonly endpoint: string;
  private readonly tokenEndpoint: string;
  private currentAccessToken: string;

  constructor(private readonly env: AppEnv) {
    this.endpoint = `https://${env.shopifyStore}/admin/api/${env.shopifyApiVersion}/graphql.json`;
    this.tokenEndpoint = `https://${env.shopifyStore}/admin/oauth/access_token`;
    this.currentAccessToken = env.shopifyAccessToken;
  }

  async request<TData>(query: string, variables?: Record<string, unknown>): Promise<TData> {
    const initialToken = this.getCurrentAccessToken();
    let response = await this.executeRequest(query, variables, initialToken);

    if (response.status === 401) {
      const refreshedToken = await this.refreshAccessTokenFromOauth();
      if (refreshedToken) {
        response = await this.executeRequest(query, variables, refreshedToken);
      } else {
        const envReloadedToken = this.getCurrentAccessToken();
        response = await this.executeRequest(query, variables, envReloadedToken);
      }
    }

    if (!response.ok) {
      const body = await response.text();
      throw new ShopifyHttpError(
        response.status,
        response.statusText,
        body,
        this.endpoint
      );
    }

    const payload = (await response.json()) as ShopifyGraphQLResponse<TData>;

    if (payload.errors && payload.errors.length > 0) {
      throw new ShopifyGraphqlError(payload.errors);
    }

    if (!payload.data) {
      throw new Error("Shopify GraphQL response did not include data.");
    }

    return payload.data;
  }

  private async executeRequest(
    query: string,
    variables: Record<string, unknown> | undefined,
    accessToken: string
  ): Promise<Response> {
    return fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken
      },
      body: JSON.stringify({ query, variables })
    });
  }

  private getCurrentAccessToken(): string {
    const envToken = this.reloadAccessTokenFromEnv();
    if (envToken) {
      this.currentAccessToken = envToken;
    }

    return this.currentAccessToken;
  }

  private reloadAccessTokenFromEnv(): string | null {
    dotenv.config({ override: true });
    const token = process.env.SHOPIFY_ACCESS_TOKEN?.trim();
    if (token && token !== this.currentAccessToken) {
      console.warn("Shopify access token updated from environment.");
    }

    return token || null;
  }

  private async refreshAccessTokenFromOauth(): Promise<string | null> {
    const clientId = process.env.SHOPIFY_CLIENT_ID?.trim();
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET?.trim();
    const refreshToken = process.env.SHOPIFY_REFRESH_TOKEN?.trim();
    const grantType =
      process.env.SHOPIFY_OAUTH_GRANT_TYPE?.trim().toLowerCase() ||
      (refreshToken ? "refresh_token" : "client_credentials");

    if (!clientId || !clientSecret) {
      return null;
    }

    if (grantType === "refresh_token" && !refreshToken) {
      console.error(
        "Shopify OAuth refresh requires SHOPIFY_REFRESH_TOKEN when SHOPIFY_OAUTH_GRANT_TYPE=refresh_token."
      );
      return null;
    }

    const body = new URLSearchParams({
      grant_type: grantType,
      client_id: clientId,
      client_secret: clientSecret
    });

    if (grantType === "refresh_token" && refreshToken) {
      body.set("refresh_token", refreshToken);
    }

    const response = await fetch(this.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(
        `Shopify OAuth token refresh failed: ${response.status} ${response.statusText}`
      );
      if (body) {
        console.error(`Shopify OAuth refresh response: ${body}`);
      }
      return null;
    }

    const payload = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };

    const nextAccessToken = payload.access_token?.trim();
    if (!nextAccessToken) {
      console.error("Shopify OAuth refresh response did not include access_token.");
      return null;
    }

    this.currentAccessToken = nextAccessToken;
    process.env.SHOPIFY_ACCESS_TOKEN = nextAccessToken;

    const nextRefreshToken = payload.refresh_token?.trim();
    if (nextRefreshToken) {
      process.env.SHOPIFY_REFRESH_TOKEN = nextRefreshToken;
    }

    console.warn(
      `Shopify access token refreshed via OAuth endpoint using grant_type=${grantType}.`
    );
    return nextAccessToken;
  }
}
