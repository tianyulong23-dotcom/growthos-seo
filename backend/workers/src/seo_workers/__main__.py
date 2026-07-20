import argparse

WORKER_TYPES = ("analysis", "ai", "integration", "publish")


def main() -> None:
    parser = argparse.ArgumentParser(description="seo Python workers")
    parser.add_argument("--list", action="store_true", help="list available worker types")
    args = parser.parse_args()

    if args.list:
        print("\n".join(WORKER_TYPES))
        return

    parser.error("a worker command is required")


if __name__ == "__main__":
    main()
