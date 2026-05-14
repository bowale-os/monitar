import pymongo
from pymongo import MongoClient
from dotenv import load_dotenv
import os

load_dotenv()

mongo_connect = os.getenv("MONGODB_CONNECT")
print(mongo_connect)

client = MongoClient(mongo_connect)
