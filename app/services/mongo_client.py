import pymongo
from pymongo import AsyncMongoClient
from dotenv import load_dotenv
import os

load_dotenv()

mongo_connect = os.getenv("MONGODB_CONNECT")
print(mongo_connect)

mongo_client = AsyncMongoClient(mongo_connect)
